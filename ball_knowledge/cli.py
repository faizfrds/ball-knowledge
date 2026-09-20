"""Command-line entry points for the two demos.

    python -m ball_knowledge.cli match --note-file fixtures/sample_patient_note.txt
    python -m ball_knowledge.cli design "Completed phase 3 trials in moderate-to-severe atopic dermatitis, with a placebo arm and an EASI-75 endpoint"
    python -m ball_knowledge.cli enrich "Randomized, placebo-controlled trials with a biomarker-based primary endpoint" --out data/processed/enrichment
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import openai

from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.data.trec_ct import load_corpus_cache
from ball_knowledge.enrichment.crawler import run_enrichment_crawler
from ball_knowledge.enrichment.rubric import compile_enrichment_rubric
from ball_knowledge.enrichment.store import EnrichmentStore
from ball_knowledge.pipeline.design_benchmark import DesignBenchmarkConfig, run_design_benchmark
from ball_knowledge.pipeline.patient_to_trials import MatchConfig, match_patient_to_trials
from ball_knowledge.retrieval.index import TrialIndex


def _load_index(corpus_path: Path, index_dir: Path) -> TrialIndex:
    trials = list(load_corpus_cache(corpus_path))
    return TrialIndex.load(index_dir, trials)


async def _cmd_match(args: argparse.Namespace) -> None:
    index = _load_index(args.corpus, args.index_dir)
    note = Path(args.note_file).read_text() if args.note_file else args.note
    client = openai.AsyncOpenAI()
    config = MatchConfig(retrieval_k=args.retrieval_k, criteria_check_top_n=args.criteria_top_n, gate_threshold=args.gate_threshold)

    patient, matches, receipt = await match_patient_to_trials(
        patient_note=note, patient_id="cli-patient", index=index, openai_client=client, config=config
    )

    print(f"\nPatient: {patient.main_condition} | age={patient.age_years} sex={patient.sex.value}")
    print(f"diagnoses: {', '.join(patient.diagnoses)}\n")

    shown = [m for m in matches if m.label.value != "not_relevant"][: args.top]
    for i, match in enumerate(shown, 1):
        print(f"{i}. [{match.label.value.upper()}] {match.trial.nct_id} - {match.trial.title}  (score={match.rank_score:.3f})")
        if match.explanation:
            print(f"   {match.explanation}")
        for cr in match.criterion_results:
            if cr.verdict.value != "meets":
                print(f"   - {cr.criterion.kind.value}: {cr.criterion.text[:100]!r} -> {cr.verdict.value} ({cr.evaluated_by})")
        print()

    print("--- cost receipt ---")
    print(json.dumps(receipt.totals().to_dict(), indent=2))


async def _cmd_design(args: argparse.Namespace) -> None:
    index = _load_index(args.corpus, args.index_dir)
    client = openai.AsyncOpenAI()
    config = DesignBenchmarkConfig(match_threshold=args.match_threshold)

    query, matches, stats, receipt = await run_design_benchmark(
        query_text=args.query, index=index, openai_client=client, config=config
    )

    print("\nParsed query:")
    print(json.dumps(query.model_dump(), indent=2))

    matched = [m for m in matches if m.matched]
    print(f"\n{len(matched)} matched trials (of {len(matches)} code-filtered candidates)\n")
    for match in matched[: args.top]:
        probs = {k: round(v, 2) for k, v in match.probabilities.items()}
        print(f"- {match.trial.nct_id}  {match.trial.title}  enrollment={match.trial.enrollment}  probs={probs}")

    print("\nEnrollment stats for sample-size planning:")
    print(json.dumps(stats.to_dict(), indent=2))
    print("\n--- cost receipt ---")
    print(json.dumps(receipt.totals().to_dict(), indent=2))


async def _cmd_enrich(args: argparse.Namespace) -> None:
    trials = list(load_corpus_cache(args.corpus))
    if args.limit:
        trials = trials[: args.limit]
    print(f"  {len(trials)} trials in scope")

    store = EnrichmentStore.load_or_create(args.out)
    print(f"  {len(store)} trials already enriched, columns so far: {store.column_names() or 'none'}")

    client = openai.AsyncOpenAI()
    receipt = Receipt()

    print(f"\nCompiling rubric from prompt: {args.prompt!r}")
    rubric = await compile_enrichment_rubric(client, args.prompt, receipt)
    for col in rubric.columns:
        print(f"  - {col.name} (weight={col.weight}): {col.instructions}")

    def on_progress(done: int, total: int) -> None:
        print(f"  enriched {done}/{total} pending trials...", flush=True)

    await run_enrichment_crawler(
        trials,
        rubric,
        store,
        receipt,
        concurrency=args.concurrency,
        checkpoint_every=args.checkpoint_every,
        checkpoint_dir=args.out,
        on_progress=on_progress,
    )
    store.save(args.out)

    print(f"\nWrote {len(store)} trials x {len(store.column_names())} columns to {args.out}")
    print("--- cost receipt ---")
    print(json.dumps(receipt.totals().to_dict(), indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Ball Knowledge - Regeneron vertical CLI")
    parser.add_argument("--corpus", type=Path, default=Path("data/processed/trials.jsonl.gz"))
    parser.add_argument("--index-dir", type=Path, default=Path("data/index"))
    sub = parser.add_subparsers(dest="command", required=True)

    match_p = sub.add_parser("match", help="match a patient note to trials")
    match_p.add_argument("--note", type=str, default=None)
    match_p.add_argument("--note-file", type=str, default=None)
    match_p.add_argument("--top", type=int, default=10)
    match_p.add_argument("--retrieval-k", type=int, default=20000)
    match_p.add_argument("--criteria-top-n", type=int, default=200)
    match_p.add_argument("--gate-threshold", type=float, default=0.5)

    design_p = sub.add_parser("design", help="benchmark trial designs")
    design_p.add_argument("query", type=str)
    design_p.add_argument("--top", type=int, default=20)
    design_p.add_argument("--match-threshold", type=float, default=0.5)

    enrich_p = sub.add_parser("enrich", help="crawl the trial database, adding Jev-derived columns from a rubric prompt")
    enrich_p.add_argument("prompt", type=str, help="free-text rubric, e.g. 'randomized, placebo-controlled trials with a biomarker endpoint'")
    enrich_p.add_argument("--out", type=Path, default=Path("data/processed/enrichment"), help="enrichment store directory (created if missing, reused/extended if present)")
    enrich_p.add_argument("--limit", type=int, default=None, help="only crawl the first N trials (for a quick test run)")
    enrich_p.add_argument("--concurrency", type=int, default=None)
    enrich_p.add_argument("--checkpoint-every", type=int, default=2000, help="trials per chunk before the store is saved to disk, so a long crawl can be safely interrupted and resumed")

    args = parser.parse_args()
    if args.command == "match":
        if not args.note and not args.note_file:
            parser.error("match requires --note or --note-file")
        asyncio.run(_cmd_match(args))
    elif args.command == "design":
        asyncio.run(_cmd_design(args))
    elif args.command == "enrich":
        asyncio.run(_cmd_enrich(args))


if __name__ == "__main__":
    main()
