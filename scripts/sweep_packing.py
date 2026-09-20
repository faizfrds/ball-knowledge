#!/usr/bin/env python3
"""How many items can we pack into one Jev request before the answers drift?

Packing is what makes the throughput story work (1,200 requests/min is the binding
limit, not tokens/s), so the question is not whether it is faster -- it obviously is
-- but where accuracy starts to pay for it. We treat one-item-per-request as the
reference and measure every packed setting against it.

Writes results/packing_sweep.json and results/packing_sweep.png.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import duckdb
from ballknowledge.jev import JevClient, noul, p_true

QUESTION = noul(
    instructions=("Does this research paper use or study large language models, "
                  "transformer language models, or LLM-based systems?"),
    true=("The abstract describes using, training, evaluating, or studying large "
          "language models, transformers used for language, or systems built on them."),
    false=("The abstract does not involve large language models. Other machine "
           "learning, other neural networks, and non-LLM AI count as false."),
)


def load(db: str, n: int) -> list[str]:
    con = duckdb.connect(db, read_only=True)
    rows = con.execute("""
        SELECT title, abstract FROM works
        WHERE abstract IS NOT NULL AND length(abstract) BETWEEN 400 AND 2500
          AND publication_year >= 2020
        ORDER BY hash(work_id) LIMIT ?
    """, [n]).fetchall()
    con.close()
    return [f"Title: {t}\n\nAbstract: {a}" for t, a in rows]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Sweep Jev packing density.")
    p.add_argument("--db", default="data/processed/ball.duckdb")
    p.add_argument("--n", type=int, default=200)
    p.add_argument("--sizes", default="10,25,50,100,150")
    p.add_argument("--workers", type=int, default=12)
    args = p.parse_args(argv)

    items = load(args.db, args.n)
    print(f"reference pass: {len(items)} abstracts, one per request")
    ref = JevClient(workers=args.workers)
    t0 = time.time()
    a_ref = ref.judge_per_item(items, {"llm": QUESTION})
    ref_t, ref_u = time.time() - t0, ref.usage.as_dict()
    ref.close()
    pr = [p_true(a["llm"]) for a in a_ref]
    pos = sum(x >= .5 for x in pr)
    print(f"  {ref_t:.1f}s  {ref_u['requests']} req  ${ref_u['cost_usd']:.4f}  "
          f"positives={pos}/{len(pr)}\n")

    rows = [{"per_request": 1, "seconds": round(ref_t, 2), **ref_u,
             "agreement": 1.0, "mad": 0.0, "returned": len(pr),
             "items_per_sec": round(len(items) / ref_t, 1)}]

    for size in [int(s) for s in args.sizes.split(",")]:
        c = JevClient(workers=args.workers)
        t0 = time.time()
        try:
            a_pk = c.judge_packed(items, {"llm": QUESTION}, per_request=size)
        except Exception as e:
            print(f"  packed@{size:<4} FAILED: {type(e).__name__}: {str(e)[:120]}")
            c.close()
            rows.append({"per_request": size, "error": f"{type(e).__name__}: {str(e)[:160]}"})
            continue
        dt, u = time.time() - t0, c.usage.as_dict()
        c.close()
        pp = [p_true(a["llm"]) if a.get("llm") else None for a in a_pk]
        ok = [(x, y) for x, y in zip(pr, pp) if y is not None]
        agree = sum((x >= .5) == (y >= .5) for x, y in ok) / max(len(ok), 1)
        mad = sum(abs(x - y) for x, y in ok) / max(len(ok), 1)
        rows.append({"per_request": size, "seconds": round(dt, 2), **u,
                     "agreement": round(agree, 4), "mad": round(mad, 4),
                     "returned": len(ok), "items_per_sec": round(len(items) / dt, 1)})
        print(f"  packed@{size:<4} {dt:6.1f}s  {u['requests']:>3} req  "
              f"${u['cost_usd']:.4f}  returned {len(ok)}/{len(items)}  "
              f"agree {agree:.1%}  mad {mad:.3f}  {len(items)/dt:.0f} items/s")

    out = Path("results")
    out.mkdir(exist_ok=True)
    payload = {"n_items": len(items), "question": "llm_usage",
               "reference_positives": pos, "rows": rows}
    (out / "packing_sweep.json").write_text(json.dumps(payload, indent=2))

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        good = [r for r in rows if "error" not in r]
        fig, ax = plt.subplots(1, 3, figsize=(13, 3.6))
        x = [r["per_request"] for r in good]
        ax[0].plot(x, [r["agreement"] * 100 for r in good], "o-", color="#2563eb")
        ax[0].axhline(95, ls="--", c="#94a3b8"); ax[0].set_ylabel("% agree with per-item")
        ax[1].plot(x, [r["mad"] for r in good], "o-", color="#dc2626")
        ax[1].set_ylabel("mean abs prob diff")
        ax[2].plot(x, [r["items_per_sec"] for r in good], "o-", color="#059669")
        ax[2].set_ylabel("items / second")
        for a_, t_ in zip(ax, ["Accuracy holds?", "Probability drift", "Throughput"]):
            a_.set_xlabel("items per request"); a_.set_xscale("log"); a_.set_title(t_)
            a_.grid(alpha=.3)
        fig.suptitle(f"Jev packing sweep — {len(items)} MIT abstracts, LLM-usage question")
        fig.tight_layout()
        fig.savefig(out / "packing_sweep.png", dpi=140)
        print(f"\nwrote {out/'packing_sweep.json'} and {out/'packing_sweep.png'}")
    except Exception as e:
        print(f"\nwrote JSON; plot skipped: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
