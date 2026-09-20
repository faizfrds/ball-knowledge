"""Runs the enrichment crawler (ball_knowledge.enrichment) over the union of
each topic's top-K BM25 candidates, rather than the full corpus - the only
trials whose enrichment columns can possibly affect ranking/NDCG@10 for a
given topic set are the ones that make it into that topic's candidate pool in
the first place, so crawling the rest is pure waste.

    python scripts/enrich_topic_pool.py \\
        --topics data/raw/topics2021.xml \\
        --prompt "Randomized, placebo- or active-controlled trials with a clearly defined primary endpoint and an adequately described patient population" \\
        --out data/processed/enrichment_2021
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import openai

from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.data.trec_ct import load_corpus_cache, parse_topics
from ball_knowledge.enrichment.crawler import run_enrichment_crawler
from ball_knowledge.enrichment.rubric import compile_enrichment_rubric
from ball_knowledge.enrichment.store import EnrichmentStore
from ball_knowledge.retrieval.index import TrialIndex


def build_topic_candidate_pool(index: TrialIndex, topics: list[tuple[str, str]], *, pool_k: int) -> list:
    positions: set[int] = set()
    for _topic_id, topic_text in topics:
        for pos, _score in index.search(topic_text, k=pool_k, use_bm25=True, use_embeddings=False):
            positions.add(pos)
    return [index.trials[p] for p in sorted(positions)]


async def main_async(args: argparse.Namespace) -> None:
    print("Loading corpus cache...")
    trials = list(load_corpus_cache(args.corpus))
    print(f"  {len(trials)} trials")

    print("Loading index...")
    index = TrialIndex.load(args.index_dir, trials)
    if not index.has_bm25:
        raise SystemExit(f"No BM25 index at {args.index_dir}; run scripts/build_index.py first.")

    topics = parse_topics(args.topics)
    if args.topic_limit:
        topics = topics[: args.topic_limit]
    print(f"  {len(topics)} topics")

    print(f"\nBuilding candidate pool (top {args.pool_k} BM25 per topic)...")
    pool = build_topic_candidate_pool(index, topics, pool_k=args.pool_k)
    print(f"  {len(pool)} unique trials across {len(topics)} topics")

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
        pool,
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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--corpus", type=Path, default=Path("data/processed/trials.jsonl.gz"))
    parser.add_argument("--index-dir", type=Path, default=Path("data/index"))
    parser.add_argument("--topics", type=Path, default=Path("data/raw/topics2021.xml"))
    parser.add_argument("--topic-limit", type=int, default=None)
    parser.add_argument("--pool-k", type=int, default=200, help="top-K BM25 candidates per topic that get unioned into the enrichment pool")
    parser.add_argument("--prompt", type=str, required=True, help="free-text enrichment rubric")
    parser.add_argument("--out", type=Path, required=True, help="enrichment store directory")
    parser.add_argument("--concurrency", type=int, default=None)
    parser.add_argument("--checkpoint-every", type=int, default=1000)
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
