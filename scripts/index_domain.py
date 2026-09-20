#!/usr/bin/env python3
"""Embed and BM25-index any domain, using its own index_sql and directory.

  uv run python scripts/index_domain.py --domain constituents
"""
from __future__ import annotations

import argparse, json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import duckdb, numpy as np
from ballknowledge.domain import get
from ballknowledge.index import build_bm25

MODEL, DIMS = "text-embedding-3-small", 1536


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Build the search index for a domain.")
    ap.add_argument("--domain", default="constituents")
    ap.add_argument("--batch-size", type=int, default=256)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args(argv)

    d = get(args.domain)
    out = Path(d.processed); out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(d.db, read_only=True)
    rows = con.execute(f"SELECT {d.id_col}, {d.index_sql} FROM {d.table} "
                       f"ORDER BY {d.id_col}").fetchall()
    con.close()
    ids = [r[0] for r in rows]
    texts = [(r[1] or "")[:6000] for r in rows]
    print(f"{d.name}: embedding {len(texts):,} rows", flush=True)

    from openai import OpenAI
    client = OpenAI(api_key=os.environ.get("OPENAI_EMBED_KEY")
                    or os.environ.get("OPENAI_API_KEY"))
    emb = np.zeros((len(texts), DIMS), dtype=np.float16)
    done, tok, t0 = [0], [0], time.time()

    def run(i):
        batch = texts[i:i + args.batch_size]
        for attempt in range(6):
            try:
                r = client.embeddings.create(model=MODEL, input=batch); break
            except Exception:
                if attempt == 5: raise
                time.sleep(2 ** attempt)
        for j, item in enumerate(r.data):
            v = np.asarray(item.embedding, dtype=np.float32)
            v /= (np.linalg.norm(v) + 1e-12)
            emb[i + j] = v.astype(np.float16)
        done[0] += len(batch); tok[0] += r.usage.total_tokens

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(run, range(0, len(texts), args.batch_size)))
    np.save(out / "embeddings.npy", emb)
    (out / "embed_ids.json").write_text(json.dumps(ids))
    print(f"  {done[0]:,} vectors in {time.time()-t0:.0f}s, "
          f"${tok[0]/1e6*0.02:.3f}", flush=True)

    build_bm25(processed=d.processed, db=d.db, table=d.table,
               id_col=d.id_col, index_sql=d.index_sql)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
