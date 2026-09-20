#!/usr/bin/env python3
"""Parse the downloaded TREC corpus once into a cache, then build the BM25 +
embedding index over it. Parsing is CPU-bound and slow at full scale (~375k
trials); embedding calls the OpenAI Embeddings API (`text-embedding-3-small`,
$0.02/1M input tokens - embedding the full registry costs well under $1) and
needs `OPENAI_API_KEY` set. Both are meant to be run once, offline; everything
downstream (the app, eval harness) loads the cached artifacts.

Usage:
    python scripts/build_index.py                 # full corpus, BM25 + embeddings
    python scripts/build_index.py --limit 5000     # fast smoke test on a slice
    python scripts/build_index.py --no-embeddings  # BM25 only, skip the embedding pass (and its cost)
    python scripts/build_index.py --skip-parse     # corpus cache already built; just (re)build the index
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ball_knowledge.data.trec_ct import build_corpus_cache, load_corpus_cache  # noqa: E402
from ball_knowledge.retrieval.index import TrialIndex  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--raw-dir", type=Path, default=ROOT / "data" / "raw")
    parser.add_argument("--corpus", type=Path, default=ROOT / "data" / "processed" / "trials.jsonl.gz")
    parser.add_argument("--index-dir", type=Path, default=ROOT / "data" / "index")
    parser.add_argument("--limit", type=int, default=None, help="only index the first N trials (for a fast smoke test)")
    parser.add_argument("--no-embeddings", action="store_true", help="skip the sentence-embedding pass; BM25 only")
    parser.add_argument("--skip-parse", action="store_true", help="reuse an existing corpus cache instead of re-parsing the raw zips")
    parser.add_argument("--embedding-batch-size", type=int, default=256)
    args = parser.parse_args()

    if not args.skip_parse:
        print(f"Parsing raw corpus from {args.raw_dir} -> {args.corpus}")
        t0 = time.perf_counter()
        count = build_corpus_cache(args.raw_dir, args.corpus)
        print(f"  parsed {count} trials in {time.perf_counter() - t0:.1f}s")
    elif not args.corpus.exists():
        raise SystemExit(f"--skip-parse given but {args.corpus} doesn't exist")

    print("Loading corpus cache...")
    trials = list(load_corpus_cache(args.corpus))
    if args.limit:
        trials = trials[: args.limit]
    print(f"  {len(trials)} trials")

    index = TrialIndex(trials)

    print("Building BM25 index...")
    t0 = time.perf_counter()
    index.build_bm25()
    print(f"  done in {time.perf_counter() - t0:.1f}s")

    if not args.no_embeddings:
        print("Building sentence embeddings (this is the slow part)...")
        t0 = time.perf_counter()
        index.build_embeddings(batch_size=args.embedding_batch_size, show_progress=True)
        print(f"  done in {time.perf_counter() - t0:.1f}s")

    print(f"Saving index to {args.index_dir}")
    index.save(args.index_dir)
    print("Done.")


if __name__ == "__main__":
    main()
