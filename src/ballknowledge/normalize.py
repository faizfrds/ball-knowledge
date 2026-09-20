#!/usr/bin/env python3
"""Turn the raw MIT works shards into flat Parquet tables plus a DuckDB database.

OpenAlex ships abstracts as an inverted index ({token: [positions]}) because of
publisher redistribution terms; reconstructing the prose is the first enrichment
step and everything downstream (embeddings, BM25, Jev) reads the result.

Outputs under data/processed/:
  works.parquet        one row per work, abstract reconstructed
  authorships.parquet  one row per (work, author)
  ball.duckdb          views over both
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

MIT = "https://openalex.org/I63966007"


def reconstruct_abstract(inv: dict[str, list[int]] | None) -> str | None:
    if not inv:
        return None
    # Position -> token, then read it back in order. Positions can be sparse when
    # the publisher's index drops stopwords, so we sort rather than index directly.
    pairs = [(pos, tok) for tok, positions in inv.items() for pos in positions]
    if not pairs:
        return None
    pairs.sort()
    return " ".join(tok for _, tok in pairs)


def short_id(url: str | None) -> str | None:
    return url.rsplit("/", 1)[-1] if url else None


def flatten(shard_dir: Path):
    works, authorships = [], []
    for path in sorted(shard_dir.glob("works_*.jsonl.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            for line in fh:
                w = json.loads(line)
                wid = short_id(w.get("id"))
                topics = w.get("topics") or []
                t0 = topics[0] if topics else {}
                loc = w.get("primary_location") or {}
                src = loc.get("source") or {}
                auths = w.get("authorships") or []
                mit_authors = 0
                for a in auths:
                    insts = a.get("institutions") or []
                    is_mit = any(i.get("id") == MIT for i in insts)
                    mit_authors += is_mit
                    au = a.get("author") or {}
                    authorships.append({
                        "work_id": wid,
                        "author_id": short_id(au.get("id")),
                        "author_name": au.get("display_name"),
                        "orcid": au.get("orcid"),
                        "position": a.get("author_position"),
                        "is_mit": is_mit,
                        "institution_names": [i.get("display_name") for i in insts],
                        "institution_ids": [short_id(i.get("id")) for i in insts],
                    })
                works.append({
                    "work_id": wid,
                    "doi": w.get("doi"),
                    "title": w.get("title"),
                    "abstract": reconstruct_abstract(w.get("abstract_inverted_index")),
                    "publication_year": w.get("publication_year"),
                    "publication_date": w.get("publication_date"),
                    "type": w.get("type"),
                    "language": w.get("language"),
                    "cited_by_count": w.get("cited_by_count"),
                    "fwci": w.get("fwci"),
                    "referenced_works_count": w.get("referenced_works_count"),
                    "is_oa": (w.get("open_access") or {}).get("is_oa"),
                    "oa_url": (w.get("open_access") or {}).get("oa_url"),
                    "venue": src.get("display_name"),
                    "venue_type": src.get("type"),
                    "topic_id": short_id(t0.get("id")),
                    "topic": t0.get("display_name"),
                    "subfield": ((t0.get("subfield") or {}).get("display_name")),
                    "field": ((t0.get("field") or {}).get("display_name")),
                    "domain": ((t0.get("domain") or {}).get("display_name")),
                    "topic_ids": [short_id(t.get("id")) for t in topics],
                    "topic_names": [t.get("display_name") for t in topics],
                    "keywords": [(k.get("display_name") or k.get("keyword"))
                                 for k in (w.get("keywords") or [])],
                    "n_authors": len(auths),
                    "n_mit_authors": mit_authors,
                    "institutions_distinct_count": w.get("institutions_distinct_count"),
                })
        print(f"  read {path.name}: {len(works):,} works so far", flush=True)
    return works, authorships


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Normalize MIT works shards to Parquet + DuckDB.")
    p.add_argument("--shard-dir", default="data/raw/mit_works")
    p.add_argument("--out-dir", default="data/processed")
    args = p.parse_args(argv)

    shard_dir, out = Path(args.shard_dir), Path(args.out_dir)
    if not any(shard_dir.glob("works_*.jsonl.gz")):
        print(f"error: no shards in {shard_dir}; run pull_openalex.py first", file=sys.stderr)
        return 1
    out.mkdir(parents=True, exist_ok=True)

    works, authorships = flatten(shard_dir)
    pq.write_table(pa.Table.from_pylist(works), out / "works.parquet", compression="zstd")
    pq.write_table(pa.Table.from_pylist(authorships), out / "authorships.parquet",
                   compression="zstd")

    db = out / "ball.duckdb"
    db.unlink(missing_ok=True)
    con = duckdb.connect(str(db))
    con.execute(f"CREATE VIEW works AS SELECT * FROM read_parquet('{out/'works.parquet'}')")
    con.execute(f"CREATE VIEW authorships AS SELECT * FROM read_parquet('{out/'authorships.parquet'}')")
    n_abs = con.execute("SELECT count(*) FROM works WHERE abstract IS NOT NULL").fetchone()[0]
    n_auth = con.execute("SELECT count(DISTINCT author_id) FROM authorships WHERE is_mit").fetchone()[0]
    print(f"\nworks: {len(works):,}  with abstract: {n_abs:,}")
    print(f"authorship rows: {len(authorships):,}  distinct MIT-affiliated authors: {n_auth:,}")
    print(f"wrote {out/'works.parquet'}, {out/'authorships.parquet'}, {db}")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
