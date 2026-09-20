#!/usr/bin/env python3
"""Embed title+abstract with OpenAI text-embedding-3-small.

Two things this has to survive: a hard tokens-per-minute ceiling, and its own death.

The TPM ceiling is enforced with a shared bucket spent using EXACT tiktoken counts --
estimating tokens as chars/4 under-counts scientific abstracts badly enough to blow
through a nominal ceiling. The bucket is also sized below the real limit, because the
limit is enforced on the server's accounting, not ours.

Surviving death means checkpointing: shards are written to disk as they complete, so
a crash costs one shard rather than the whole run, and a re-run resumes from what is
already on disk. Vectors are float16 -- brute-force cosine over this corpus is well
under a second and the index has to sit in memory next to everything else.

Writes data/processed/emb_shards/*.npz, then merges to embeddings.npy + embed_ids.json.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb
import numpy as np

MODEL = "text-embedding-3-small"
DIMS = 1536
PRICE_PER_MTOK = 0.02


class TokenBudget:
    """Keep the whole pool under a tokens-per-minute ceiling.

    Backoff alone cannot fix a TPM limit: every worker just retries into the same
    exhausted budget. Spending from a shared refilling bucket does."""

    def __init__(self, per_minute: int):
        self.capacity = per_minute
        self.tokens = float(per_minute)
        self.rate = per_minute / 60.0
        self.last = time.time()
        self.lock = threading.Lock()

    def spend(self, n: int) -> None:
        n = min(n, self.capacity)
        while True:
            with self.lock:
                now = time.time()
                self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
                self.last = now
                if self.tokens >= n:
                    self.tokens -= n
                    return
                wait = (n - self.tokens) / self.rate
            time.sleep(min(wait, 5.0))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Embed MIT works with OpenAI.")
    p.add_argument("--db", default="data/processed/ball.duckdb")
    p.add_argument("--out-dir", default="data/processed")
    p.add_argument("--batch-size", type=int, default=96)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--tpm", type=int, default=600_000,
                   help="tokens-per-minute ceiling; keep well under the org limit")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--max-chars", type=int, default=4000)
    args = p.parse_args(argv)

    if not (os.environ.get("OPENAI_EMBED_KEY") or os.environ.get("OPENAI_API_KEY")):
        print("error: no OPENAI_EMBED_KEY or OPENAI_API_KEY set", file=sys.stderr)
        return 2

    out = Path(args.out_dir)
    shard_dir = out / "emb_shards"
    shard_dir.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(args.db, read_only=True)
    q = ("SELECT work_id, title, abstract FROM works "
         "WHERE abstract IS NOT NULL ORDER BY work_id")
    if args.limit:
        q += f" LIMIT {args.limit}"
    rows = con.execute(q).fetchall()
    con.close()

    # Resume: anything already on disk, in a finished shard or a previous merge.
    have: set[str] = set()
    for f in sorted(shard_dir.glob("*.npz")):
        try:
            have.update(np.load(f, allow_pickle=True)["ids"].tolist())
        except Exception:
            f.unlink(missing_ok=True)
    if (out / "embed_ids.json").exists():
        have.update(json.loads((out / "embed_ids.json").read_text()))
    todo = [r for r in rows if r[0] not in have]
    print(f"corpus {len(rows):,} | already embedded {len(have):,} | to do {len(todo):,}",
          flush=True)

    if todo:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        from openai import OpenAI
        client = OpenAI(max_retries=0,   # we do our own, budget-aware retries
                        api_key=os.environ.get("OPENAI_EMBED_KEY")
                                or os.environ.get("OPENAI_API_KEY"))

        texts = [f"{r[1] or ''}\n\n{r[2] or ''}"[:args.max_chars] for r in todo]
        ids = [r[0] for r in todo]
        budget = TokenBudget(args.tpm)
        counters = {"done": 0, "tokens": 0, "shards": 0}
        lock = threading.Lock()
        t0 = time.time()

        chunks = [(i, texts[i:i + args.batch_size], ids[i:i + args.batch_size])
                  for i in range(0, len(texts), args.batch_size)]

        def run(chunk):
            start, batch, batch_ids = chunk
            need = sum(len(enc.encode(b)) for b in batch)   # exact, not estimated
            for attempt in range(10):
                budget.spend(need)
                try:
                    r = client.embeddings.create(model=MODEL, input=batch)
                    break
                except Exception as e:
                    if attempt == 9:
                        print(f"  chunk at {start} failed permanently: {type(e).__name__}",
                              flush=True)
                        return
                    # A 429 means the server's accounting disagrees with ours; wait
                    # out its suggested delay before spending again.
                    time.sleep(min(3 * (attempt + 1), 30))
            vecs = np.zeros((len(batch), DIMS), dtype=np.float16)
            for j, d in enumerate(r.data):
                v = np.asarray(d.embedding, dtype=np.float32)
                v /= (np.linalg.norm(v) + 1e-12)   # normalize once; search is a dot product
                vecs[j] = v.astype(np.float16)
            # Checkpoint immediately: one shard lost is recoverable, a whole run is not.
            np.savez(shard_dir / f"shard_{start:07d}.npz",
                     ids=np.array(batch_ids, dtype=object), vecs=vecs)
            with lock:
                counters["done"] += len(batch)
                counters["tokens"] += r.usage.total_tokens
                counters["shards"] += 1
                if counters["shards"] % 40 == 0:
                    el = time.time() - t0
                    print(f"  {counters['done']:,}/{len(texts):,}  {el:.0f}s  "
                          f"{counters['done']/max(el,1e-9):.0f}/s  "
                          f"${counters['tokens']/1e6*PRICE_PER_MTOK:.2f}", flush=True)

        with ThreadPoolExecutor(args.workers) as ex:
            list(ex.map(run, chunks))
        el = time.time() - t0
        print(f"\nembedded {counters['done']:,} in {el:.0f}s, "
              f"${counters['tokens']/1e6*PRICE_PER_MTOK:.2f}")

    # Merge every shard (plus any previous merge) into one matrix.
    all_ids: list[str] = []
    mats: list[np.ndarray] = []
    if (out / "embed_ids.json").exists() and (out / "embeddings.npy").exists():
        all_ids += json.loads((out / "embed_ids.json").read_text())
        mats.append(np.load(out / "embeddings.npy"))
    for f in sorted(shard_dir.glob("*.npz")):
        z = np.load(f, allow_pickle=True)
        all_ids += z["ids"].tolist()
        mats.append(z["vecs"])
    if not mats:
        print("nothing to merge", file=sys.stderr)
        return 1
    emb = np.vstack(mats)
    seen, keep = set(), []
    for i, w in enumerate(all_ids):
        if w not in seen:
            seen.add(w)
            keep.append(i)
    emb, all_ids = emb[keep], [all_ids[i] for i in keep]
    np.save(out / "embeddings.npy", emb)
    (out / "embed_ids.json").write_text(json.dumps(all_ids))
    print(f"merged {emb.shape[0]:,} vectors ({emb.nbytes/1e6:.0f} MB) -> {out/'embeddings.npy'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
