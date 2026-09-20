#!/usr/bin/env python3
"""Settle the one assumption the whole throughput story rests on.

The plan claims ~110 items per Jev call. The docs say one request = one state =
one set of answers, and the documented fan-out pattern is many questions about ONE
item. Packing an array into state and naming a question per item is within
contract, but nothing says it stays accurate when each question reads 100 items.

This script runs the SAME question over the SAME abstracts twice -- once per-item
(the trusted reference), once packed -- and reports how far apart they land, plus
the real cost and wall-clock of each. Run it before building anything on packing.

  python scripts/validate_packing.py --n 60 --per-request 30
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import duckdb
from ballknowledge.jev import JevClient, Usage, noul, p_true

QUESTION = noul(
    instructions=("Does this research paper use or study large language models, "
                  "transformer language models, or LLM-based systems?"),
    true=("The abstract describes using, training, evaluating, or studying large "
          "language models, transformers used for language, or systems built on them."),
    false=("The abstract does not involve large language models. Other machine "
           "learning, other neural networks, and non-LLM AI count as false."),
)


def load_abstracts(db: str, n: int) -> list[tuple[str, str]]:
    con = duckdb.connect(db, read_only=True)
    rows = con.execute("""
        SELECT title, abstract FROM works
        WHERE abstract IS NOT NULL AND length(abstract) BETWEEN 400 AND 2000
          AND publication_year >= 2022
        ORDER BY hash(work_id) LIMIT ?
    """, [n]).fetchall()
    con.close()
    return rows


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Compare per-item vs packed Jev batching.")
    p.add_argument("--db", default="data/processed/ball.duckdb")
    p.add_argument("--n", type=int, default=60, help="abstracts to test")
    p.add_argument("--per-request", type=int, default=30, help="items per packed call")
    p.add_argument("--workers", type=int, default=8)
    args = p.parse_args(argv)

    if not os.environ.get("TYPESAFE_API_KEY"):
        print("error: TYPESAFE_API_KEY is not set.", file=sys.stderr)
        return 2
    if not Path(args.db).exists():
        print(f"error: {args.db} not found; run normalize.py first", file=sys.stderr)
        return 1

    rows = load_abstracts(args.db, args.n)
    items = [f"Title: {t}\n\nAbstract: {a}" for t, a in rows]
    print(f"Testing {len(items)} abstracts, packed at {args.per_request}/request\n")

    ref = JevClient(workers=args.workers)
    t0 = time.time()
    a_ref = ref.judge_per_item(items, {"llm": QUESTION})
    t_ref = time.time() - t0
    u_ref = ref.usage.as_dict()
    ref.close()
    print(f"per-item : {t_ref:6.1f}s  {u_ref['requests']:>4} requests  "
          f"{u_ref['input_tokens']:>9,} tok  ${u_ref['cost_usd']:.4f}")

    pk = JevClient(workers=args.workers)
    t0 = time.time()
    a_pk = pk.judge_packed(items, {"llm": QUESTION}, per_request=args.per_request)
    t_pk = time.time() - t0
    u_pk = pk.usage.as_dict()
    pk.close()
    print(f"packed   : {t_pk:6.1f}s  {u_pk['requests']:>4} requests  "
          f"{u_pk['input_tokens']:>9,} tok  ${u_pk['cost_usd']:.4f}")

    pr = [p_true(a["llm"]) for a in a_ref]
    pp = [p_true(a.get("llm")) if a.get("llm") else float("nan") for a in a_pk]
    ok = [(x, y) for x, y in zip(pr, pp) if y == y]
    missing = len(pp) - len(ok)
    agree = sum((x >= .5) == (y >= .5) for x, y in ok)
    mad = sum(abs(x - y) for x, y in ok) / max(len(ok), 1)

    print(f"\nanswers returned by packed mode : {len(ok)}/{len(items)}"
          f"{f'  ({missing} MISSING)' if missing else ''}")
    print(f"label agreement at p>=0.5       : {agree}/{len(ok)} "
          f"({100*agree/max(len(ok),1):.0f}%)")
    print(f"mean absolute prob difference   : {mad:.3f}")
    print(f"cost ratio (packed/per-item)    : "
          f"{u_pk['cost_usd']/max(u_ref['cost_usd'],1e-9):.2f}x")
    print(f"speed ratio (per-item/packed)   : {t_ref/max(t_pk,1e-9):.2f}x")

    print("\nverdict:", end=" ")
    if missing or agree / max(len(ok), 1) < 0.90:
        print("PACKING IS NOT SAFE -- use per-item mode and re-scope the throughput claims.")
    elif mad > 0.15:
        print("packing shifts probabilities; fine for ranking, NOT for calibrated shares.")
    else:
        print("packing holds up; the throughput numbers in the plan are reachable.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
