"""Runs every system in the shared results table over TREC-CT-2021 and reports
NDCG@10, eligible-vs-excluded accuracy, tokens/query, $/query, and latency - the
same table every Ball Knowledge vertical fills in.

Usage (see README.md for the full walkthrough):

    python -m ball_knowledge.eval.run_eval \\
        --corpus data/processed/trials.jsonl.gz \\
        --index-dir data/index \\
        --topics data/raw/topics2021.xml \\
        --qrels data/raw/qrels2021.txt \\
        --systems bm25,hybrid,ball_knowledge \\
        --topic-limit 10 \\
        --out eval_results

`bm25` and `hybrid` need no API keys and are cheap to run over all 75 topics.
`hybrid_rerank` needs `COHERE_API_KEY`. `llm_only` and `ball_knowledge` need
`OPENAI_API_KEY` (and `ball_knowledge` also needs `TYPESAFE_API_KEY`) and cost
real money - keep `--topic-limit` small while iterating.

LLM-only is run on a slice (`--llm-only-slice` items per topic, default 1000) and
its tokens/cost/latency are then scaled linearly to `--bk-retrieval-k` (Ball
Knowledge's own pool size) so the two rows are comparable; its quality (NDCG,
accuracy) is reported from the slice as measured, not scaled.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from dataclasses import dataclass
from pathlib import Path

import openai

from ball_knowledge.config import SETTINGS
from ball_knowledge.cost_receipt import ReceiptTotals
from ball_knowledge.data.trec_ct import load_corpus_cache, parse_qrels, parse_topics
from ball_knowledge.eval.baselines import SystemRunResult, run_bm25_only, run_hybrid, run_hybrid_rerank, run_llm_only
from ball_knowledge.eval.ndcg import eligible_vs_excluded_accuracy, ndcg_at_k, qrels_by_topic
from ball_knowledge.models import TrialLabel
from ball_knowledge.pipeline.patient_to_trials import MatchConfig, match_patient_to_trials
from ball_knowledge.retrieval.index import TrialIndex

ALL_SYSTEMS = ["bm25", "hybrid", "hybrid_rerank", "llm_only", "ball_knowledge"]
DISPLAY_NAME = {
    "bm25": "Keyword search (BM25)",
    "hybrid": "Hybrid (keyword + embeddings)",
    "hybrid_rerank": "Hybrid + Cohere rerank",
    "llm_only": "LLM-only, same rubric",
    "ball_knowledge": "Ball Knowledge",
}


@dataclass
class TopicRun:
    topic_id: str
    ndcg10: float
    label_correct: int
    label_total: int
    totals: ReceiptTotals


def _score(topic_id: str, result: SystemRunResult, topic_qrels: dict[str, int]) -> TopicRun:
    ndcg = ndcg_at_k(result.ranked_nct_ids, topic_qrels, k=10)
    correct, total = (0, 0)
    if result.predicted_labels:
        correct, total = eligible_vs_excluded_accuracy(result.predicted_labels, topic_qrels)
    return TopicRun(topic_id, ndcg, correct, total, result.receipt.totals())


def _aggregate(runs: list[TopicRun], *, scale_factor: float = 1.0) -> dict:
    if not runs:
        return {}
    ndcgs = [r.ndcg10 for r in runs]
    latencies = [r.totals.wall_clock_s * scale_factor for r in runs]
    ttfrs = [r.totals.time_to_first_result_s * scale_factor for r in runs if r.totals.time_to_first_result_s is not None]
    total_correct = sum(r.label_correct for r in runs)
    total_labeled = sum(r.label_total for r in runs)

    def avg_cost(pick) -> float | None:
        vals = [pick(r.totals) for r in runs]
        if any(v is None for v in vals):
            return None
        return statistics.fmean(vals) * scale_factor

    return {
        "n_topics": len(runs),
        "ndcg10_mean": statistics.fmean(ndcgs),
        "eligible_vs_excluded_accuracy": (total_correct / total_labeled) if total_labeled else None,
        "eligible_vs_excluded_n": total_labeled,
        "llm_tokens_per_query": statistics.fmean(r.totals.llm_tokens for r in runs) * scale_factor,
        "jev_tokens_per_query": statistics.fmean(r.totals.jev_tokens for r in runs) * scale_factor,
        "cost_usd_per_query": avg_cost(lambda t: t.total_cost_usd),
        "median_latency_s": statistics.median(latencies) if latencies else None,
        "time_to_first_result_s": statistics.median(ttfrs) if ttfrs else None,
        "scale_factor": scale_factor,
    }


async def _run_ball_knowledge(topic_id: str, topic_text: str, index: TrialIndex, client: openai.AsyncOpenAI, config: MatchConfig) -> SystemRunResult:
    _patient, matches, receipt = await match_patient_to_trials(
        patient_note=topic_text, patient_id=topic_id, index=index, openai_client=client, config=config
    )
    ranked = [m.trial.nct_id for m in matches]
    labels = {m.trial.nct_id: m.label.value for m in matches if m.label is not TrialLabel.NOT_RELEVANT}
    return SystemRunResult(topic_id, ranked, predicted_labels=labels, receipt=receipt)


async def run(args: argparse.Namespace) -> dict:
    print("Loading corpus cache...")
    trials = list(load_corpus_cache(args.corpus))
    print(f"  {len(trials)} trials")

    print("Loading index...")
    index = TrialIndex.load(args.index_dir, trials)
    if not index.has_bm25:
        raise SystemExit(f"No BM25 index at {args.index_dir}; run scripts/build_index.py first.")
    if "hybrid" in args.systems and not index.has_embeddings:
        print("  warning: no embeddings in this index; 'hybrid' will fall back to BM25-only ranking")

    topics = parse_topics(args.topics)
    if args.topic_limit:
        topics = topics[: args.topic_limit]
    qrels = qrels_by_topic(parse_qrels(args.qrels))
    print(f"  {len(topics)} topics")

    # Running many topics concurrently (see --topic-concurrency) means bursts of
    # requests land on the same shared per-org TPM cap; the SDK's default
    # max_retries=2 isn't enough backoff to ride that out, so raise it rather than
    # let a transient 429 fail an entire topic.
    client = (
        openai.AsyncOpenAI(api_key=SETTINGS.openai_api_key, max_retries=8)
        if {"llm_only", "ball_knowledge"} & set(args.systems)
        else None
    )
    bk_config = MatchConfig(
        retrieval_k=args.bk_retrieval_k,
        criteria_check_top_n=args.bk_criteria_top_n,
        gate_threshold=args.bk_gate_threshold,
        # TREC-CT-2021's qrels judge eligibility criteria match, not current
        # recruitment status - most ground-truth "eligible" trials in a 2021
        # snapshot are long since Completed. The production default
        # (require_recruiting=True) is right for matching a real patient
        # against trials open today, but would silently exclude ~98% of this
        # benchmark's own ground truth before retrieval ever runs.
        require_recruiting=args.bk_require_recruiting,
        use_embeddings=args.bk_use_embeddings,
        explain_with_llm=args.bk_explain_with_llm,
    )

    report: dict[str, dict] = {}
    raw: dict[str, list[dict]] = {}
    is_async_system = {"llm_only", "ball_knowledge"}

    for system in args.systems:
        print(f"\n=== {DISPLAY_NAME[system]} ===")
        runs: list[TopicRun] = []
        scale_factor = 1.0
        topic_sem = asyncio.Semaphore(args.topic_concurrency)

        async def run_one_topic(topic_id: str, topic_text: str) -> tuple[str, TopicRun | None, float, float]:
            nonlocal scale_factor
            topic_qrels = qrels.get(topic_id, {})
            start = time.perf_counter()
            try:
                if system == "bm25":
                    result = run_bm25_only(topic_id, topic_text, index)
                elif system == "hybrid":
                    result = run_hybrid(topic_id, topic_text, index)
                elif system == "hybrid_rerank":
                    result = run_hybrid_rerank(topic_id, topic_text, index)
                elif system == "llm_only":
                    async with topic_sem:
                        pool = index.search(topic_text, k=args.llm_only_slice, use_bm25=True, use_embeddings=index.has_embeddings)
                        candidates = [index.trials[pos] for pos, _score in pool]
                        scale_factor = args.bk_retrieval_k / max(1, len(candidates))
                        result = await run_llm_only(topic_id, topic_text, candidates, client, concurrency=args.llm_only_concurrency)
                elif system == "ball_knowledge":
                    async with topic_sem:
                        result = await _run_ball_knowledge(topic_id, topic_text, index, client, bk_config)
                else:
                    raise ValueError(system)
            except Exception as exc:  # noqa: BLE001 - keep the eval run going across topic failures
                print(f"  topic {topic_id}: FAILED ({exc})")
                return topic_id, None, 0.0, scale_factor

            elapsed = time.perf_counter() - start
            score_obj = _score(topic_id, result, topic_qrels)
            print(f"  topic {topic_id}: ndcg@10={score_obj.ndcg10:.3f}  ({elapsed:.1f}s)", flush=True)
            return topic_id, score_obj, elapsed, scale_factor

        # Sync systems (bm25/hybrid/hybrid_rerank) are fast in-process calls with no
        # I/O wait, so running them sequentially is already near-optimal and keeps
        # output ordered. The async systems (llm_only/ball_knowledge) are dominated
        # by LLM/Jev round-trip latency - awaiting one topic at a time there means
        # almost the whole wall clock is spent idle on network I/O, so those run
        # `--topic-concurrency` topics at once instead (each still bounded
        # internally by its own per-candidate concurrency limit).
        if system in is_async_system:
            results = await asyncio.gather(*(run_one_topic(tid, ttext) for tid, ttext in topics))
        else:
            results = [await run_one_topic(tid, ttext) for tid, ttext in topics]

        for topic_id, run_score, elapsed, _sf in results:
            if run_score is None:
                continue
            runs.append(run_score)

        report[system] = _aggregate(runs, scale_factor=scale_factor)
        raw[system] = [
            {"topic_id": r.topic_id, "ndcg10": r.ndcg10, "label_correct": r.label_correct, "label_total": r.label_total, **r.totals.to_dict()}
            for r in runs
        ]

    headline = render_headline_numbers(report)

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "summary.json").write_text(json.dumps(report, indent=2))
        (args.out / "raw.json").write_text(json.dumps(raw, indent=2))
        (args.out / "results_table.md").write_text(render_markdown_table(report) + "\n\n" + headline)
        print(f"\nWrote {args.out}/summary.json, raw.json, results_table.md")

    print("\n" + render_markdown_table(report))
    print("\n" + headline)
    return report


def render_markdown_table(report: dict[str, dict]) -> str:
    headers = ["System", "NDCG@10", "Eligible-vs-excluded acc.", "LLM tokens/query", "Jev tokens/query", "$/query", "Median latency", "Time to first result"]
    lines = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]

    def fmt(v, spec="{:.3f}"):
        return spec.format(v) if isinstance(v, (int, float)) else "—"

    for system in ALL_SYSTEMS:
        stats = report.get(system)
        if not stats:
            continue
        acc = stats.get("eligible_vs_excluded_accuracy")
        acc_str = f"{acc:.1%} (n={stats['eligible_vs_excluded_n']})" if acc is not None else "n/a (ranking only)"
        row = [
            DISPLAY_NAME[system],
            fmt(stats.get("ndcg10_mean")),
            acc_str,
            fmt(stats.get("llm_tokens_per_query"), "{:.0f}"),
            fmt(stats.get("jev_tokens_per_query"), "{:.0f}"),
            (f"${stats['cost_usd_per_query']:.4f}" if stats.get("cost_usd_per_query") is not None else "n/a (set pricing in .env)"),
            (f"{stats['median_latency_s']:.2f}s" if stats.get("median_latency_s") is not None else "—"),
            (f"{stats['time_to_first_result_s']:.2f}s" if stats.get("time_to_first_result_s") is not None else "—"),
        ]
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def render_headline_numbers(report: dict[str, dict]) -> str:
    """The four headline comparisons, each against every baseline present in
    this run (not just LLM-only) for accuracy lift, but strictly against
    LLM-only for token/cost/latency savings - LLM-only is the fair apples-to-
    apples comparison for those because it runs the same rubric, just without
    Jev or the code-side splits."""
    bk = report.get("ball_knowledge")
    llm_only = report.get("llm_only")
    lines = ["## Headline numbers"]

    if bk:
        lines.append("\n**Accuracy lift** (Ball Knowledge NDCG@10 minus each baseline's):")
        for system in ALL_SYSTEMS:
            if system == "ball_knowledge" or not report.get(system):
                continue
            lift = bk["ndcg10_mean"] - report[system]["ndcg10_mean"]
            lines.append(f"- vs {DISPLAY_NAME[system]}: {lift:+.3f}")

    if bk and llm_only:
        lines.append("\n**Ball Knowledge vs. LLM-only, same rubric:**")

        def ratio(key: str, fmt: str) -> str:
            bk_val, llm_val = bk.get(key), llm_only.get(key)
            if not bk_val or llm_val is None:
                return "n/a"
            return fmt.format(llm_val / bk_val)

        lines.append(f"- Token savings (LLM tokens/query): {ratio('llm_tokens_per_query', '{:.1f}x')}")
        lines.append(f"- Cost savings ($/query): {ratio('cost_usd_per_query', '{:.1f}x')}")
        lines.append(f"- Speedup (median latency): {ratio('median_latency_s', '{:.1f}x')}")

    if not bk:
        lines.append("\n(Run with `--systems ...,ball_knowledge` to compute headline numbers.)")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--corpus", type=Path, default=Path("data/processed/trials.jsonl.gz"))
    parser.add_argument("--index-dir", type=Path, default=Path("data/index"))
    parser.add_argument("--topics", type=Path, default=Path("data/raw/topics2021.xml"))
    parser.add_argument("--qrels", type=Path, default=Path("data/raw/qrels2021.txt"))
    parser.add_argument("--systems", type=lambda s: s.split(","), default=["bm25", "hybrid"])
    parser.add_argument("--topic-limit", type=int, default=None)
    parser.add_argument("--llm-only-slice", type=int, default=1000, help="candidates judged per topic for the LLM-only baseline")
    parser.add_argument("--llm-only-concurrency", type=int, default=6)
    parser.add_argument("--topic-concurrency", type=int, default=5, help="topics run in parallel for the async systems (llm_only, ball_knowledge)")
    parser.add_argument("--bk-retrieval-k", type=int, default=3000, help="Ball Knowledge's retrieval pool size for this eval run (spec default is 20000; smaller keeps eval cost down)")
    parser.add_argument("--bk-criteria-top-n", type=int, default=100)
    parser.add_argument("--bk-gate-threshold", type=float, default=0.5)
    parser.add_argument(
        "--bk-require-recruiting",
        action="store_true",
        default=False,
        help="apply the production 'only currently-recruiting trials' prefilter (off by default - see MatchConfig comment above)",
    )
    parser.add_argument(
        "--bk-use-embeddings",
        action="store_true",
        default=False,
        help="use hybrid embeddings in Ball Knowledge's retrieval step (default: False, BM25-only sweet spot)",
    )
    parser.add_argument(
        "--bk-explain-with-llm",
        action="store_true",
        default=False,
        help="use a second OpenAI LLM call to explain the top 10 trials (default: False, deterministic rubric explain)",
    )
    parser.add_argument("--out", type=Path, default=Path("eval_results"))
    args = parser.parse_args()

    unknown = set(args.systems) - set(ALL_SYSTEMS)
    if unknown:
        parser.error(f"unknown system(s): {unknown}; choose from {ALL_SYSTEMS}")
    if not SETTINGS.typesafe_input_price_per_mtok:
        print("note: TYPESAFE_INPUT_PRICE_PER_MTOK is not set - Jev-dependent $/query cells will read n/a")

    asyncio.run(run(args))


if __name__ == "__main__":
    main()
