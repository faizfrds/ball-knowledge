#!/usr/bin/env python3
"""Recover MIT research groups from co-authorship alone.

OpenAlex has no notion of a lab, so we build the co-authorship graph over
MIT-affiliated authors, weight edges by shared papers, and run Louvain community
detection. Each community is a candidate research group; naming it from its topics
is a separate LLM step (name_groups.py) so this stage stays deterministic.

Outputs under data/processed/:
  authors.parquet   one row per MIT author: paper count, top topics, recent titles
  groups.parquet    one row per detected group: members, topics, size, span
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

import duckdb
import networkx as nx
import pyarrow as pa
import pyarrow.parquet as pq

# Papers with huge author lists (physics collaborations, consortium genomics) would
# otherwise add tens of thousands of meaningless co-authorship edges each.
MAX_AUTHORS_PER_WORK = 25


def build(con: duckdb.DuckDBPyConnection, min_papers: int, resolution: float,
          min_edge_weight: int = 1):
    rows = con.execute("""
        SELECT a.work_id, a.author_id, a.author_name, w.publication_year,
               w.title, w.topic, w.field, w.cited_by_count
        FROM authorships a JOIN works w USING (work_id)
        WHERE a.is_mit AND a.author_id IS NOT NULL
    """).fetchall()

    by_work: dict[str, list[str]] = defaultdict(list)
    name: dict[str, str] = {}
    papers: dict[str, list[tuple]] = defaultdict(list)
    for work_id, author_id, author_name, year, title, topic, field, cites in rows:
        by_work[work_id].append(author_id)
        name.setdefault(author_id, author_name)
        papers[author_id].append((year or 0, title, topic, field, cites or 0))

    prolific = {a for a, ps in papers.items() if len(ps) >= min_papers}
    print(f"  MIT authors: {len(papers):,}  with >={min_papers} papers: {len(prolific):,}")

    weights: Counter = Counter()
    skipped = 0
    for work_id, authors in by_work.items():
        authors = [a for a in set(authors) if a in prolific]
        if len(authors) > MAX_AUTHORS_PER_WORK:
            skipped += 1
            continue
        for u, v in combinations(sorted(authors), 2):
            weights[(u, v)] += 1
    print(f"  co-authorship edges: {len(weights):,}  (skipped {skipped:,} mega-author works)")

    # A single shared paper is not a collaboration -- on large consortium papers it is
    # not even an acquaintance. Requiring repeat co-authorship is what separates labs
    # from the giant component everyone in a department belongs to.
    g = nx.Graph()
    g.add_nodes_from(prolific)
    kept = 0
    for (u, v), w in weights.items():
        if w >= min_edge_weight:
            g.add_edge(u, v, weight=w)
            kept += 1
    print(f"  edges kept at weight>={min_edge_weight}: {kept:,} of {len(weights):,}")

    comms = nx.community.louvain_communities(g, weight="weight", resolution=resolution, seed=7)
    comms = [c for c in comms if len(c) >= 3]
    sizes = sorted((len(c) for c in comms), reverse=True)
    if sizes:
        med = sizes[len(sizes) // 2]
        print(f"  sizes: max={sizes[0]}, median={med}, "
              f"groups over 100 members={sum(1 for s_ in sizes if s_ > 100)}")
    comms.sort(key=len, reverse=True)
    print(f"  groups found (>=3 members): {len(comms):,}")

    authors_tbl, group_of = [], {}
    for gi, members in enumerate(comms):
        for a in members:
            group_of[a] = f"G{gi:04d}"
    for a in prolific:
        ps = sorted(papers[a], key=lambda x: (x[0] or 0, x[4] or 0), reverse=True)
        authors_tbl.append({
            "author_id": a,
            "author_name": name.get(a),
            "group_id": group_of.get(a),
            "n_papers": len(ps),
            "total_citations": sum(p[4] for p in ps),
            "first_year": min(p[0] for p in ps if p[0]) if any(p[0] for p in ps) else None,
            "last_year": max(p[0] for p in ps),
            "top_topics": [t for t, _ in Counter(p[2] for p in ps if p[2]).most_common(5)],
            "top_fields": [f for f, _ in Counter(p[3] for p in ps if p[3]).most_common(3)],
            "recent_titles": [p[1] for p in ps[:5] if p[1]],
            "degree": g.degree(a),
        })

    groups_tbl = []
    for gi, members in enumerate(comms):
        member_papers = [p for a in members for p in papers[a]]
        sub = g.subgraph(members)
        groups_tbl.append({
            "group_id": f"G{gi:04d}",
            "size": len(members),
            "member_ids": sorted(members),
            "member_names": [name.get(a) for a in sorted(members, key=lambda x: -len(papers[x]))[:15]],
            "lead_author": name.get(max(members, key=lambda a: g.degree(a))),
            "n_papers": len({p[1] for p in member_papers}),
            "total_citations": sum(p[4] for p in member_papers),
            "top_topics": [t for t, _ in Counter(p[2] for p in member_papers if p[2]).most_common(8)],
            "top_fields": [f for f, _ in Counter(p[3] for p in member_papers if p[3]).most_common(3)],
            "first_year": min((p[0] for p in member_papers if p[0]), default=None),
            "last_year": max((p[0] for p in member_papers), default=None),
            "internal_density": round(nx.density(sub), 4),
        })
    return authors_tbl, groups_tbl


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Detect MIT research groups from co-authorship.")
    p.add_argument("--db", default="data/processed/ball.duckdb")
    p.add_argument("--out-dir", default="data/processed")
    p.add_argument("--min-papers", type=int, default=2,
                   help="drop authors with fewer MIT papers than this (default: 2)")
    p.add_argument("--resolution", type=float, default=1.0,
                   help="Louvain resolution; higher splits into smaller groups")
    p.add_argument("--min-edge-weight", type=int, default=2,
                   help="require this many co-authored papers for an edge (default: 2)")
    args = p.parse_args(argv)

    if not Path(args.db).exists():
        print(f"error: {args.db} not found; run normalize.py first", file=sys.stderr)
        return 1
    con = duckdb.connect(args.db, read_only=True)
    authors_tbl, groups_tbl = build(con, args.min_papers, args.resolution,
                                   args.min_edge_weight)
    con.close()

    out = Path(args.out_dir)
    pq.write_table(pa.Table.from_pylist(authors_tbl), out / "authors.parquet", compression="zstd")
    pq.write_table(pa.Table.from_pylist(groups_tbl), out / "groups.parquet", compression="zstd")
    top = sorted(groups_tbl, key=lambda x: -x["n_papers"])[:5]
    print("\n  largest groups by paper count:")
    for grp in top:
        print(f"    {grp['group_id']}  {grp['size']:>3} members, {grp['n_papers']:>4} papers"
              f"  lead={grp['lead_author']}  topics={grp['top_topics'][:3]}")
    print(f"\nwrote {out/'authors.parquet'}, {out/'groups.parquet'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
