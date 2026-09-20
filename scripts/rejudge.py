#!/usr/bin/env python3
"""Re-score a finished retrieval comparison with a judge that is not a contestant.

The first run used gpt-5.2 as judge while the llm_rerank arm was also gpt-5.2, so the
judge was grading its own output. Self-preference is a well-known failure mode of
LLM judging and it biases exactly the comparison this project turns on.

This re-judges the SAME saved rankings with a judge from a different provider. No
search is re-run, so the only thing that changes is who is scoring.

  uv run python scripts/rejudge.py --judge deepseek-v4-flash
"""

from __future__ import annotations

import argparse, json, math, os, random, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import duckdb
from compare_baselines import ndcg_at_k, paired_bootstrap


def judge_with(pairs, model, gateway, workers=10):
    from openai import OpenAI
    client = (OpenAI(api_key=os.environ["OPENCODE_API_KEY"],
                     base_url="https://opencode.ai/zen/go/v1",
                     default_headers={"x-opencode-session": "bk-rejudge"})
              if gateway else OpenAI())
    out, lock = {}, __import__("threading").Lock()

    def one(item):
        query, wid, text = item
        for attempt in range(4):
            try:
                r = client.chat.completions.create(
                    model=model, temperature=0,
                    messages=[{"role": "user", "content":
                        f'Search query: "{query}"\n\nPaper:\n{text[:1500]}\n\n'
                        f"Is this paper a relevant answer to the query? Judge strictly: "
                        f"every specific condition in the query must hold. "
                        f'Return JSON: {{"relevant": true or false}}'}],
                    response_format={"type": "json_object"})
                raw = r.choices[0].message.content or ""
                if "{" in raw:
                    raw = raw[raw.index("{"):raw.rindex("}") + 1]
                with lock:
                    out[(query, wid)] = int(bool(json.loads(raw).get("relevant")))
                return
            except Exception:
                if attempt == 3:
                    return
                time.sleep(2 ** attempt)

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, pairs))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Re-judge a saved retrieval comparison.")
    ap.add_argument("--in", dest="inp", default="results/baselines.json")
    ap.add_argument("--judge", default="deepseek-v4-flash")
    ap.add_argument("--gateway", action="store_true", default=True)
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--out", default="results/baselines_rejudged.json")
    args = ap.parse_args(argv)

    d = json.loads(Path(args.inp).read_text())
    per_query = d["per_query"]
    queries = d["queries"]

    pool = {(q, w) for ids in per_query.values() for q, lst in ids.items() for w in lst}
    wids = sorted({w for _, w in pool})
    con = duckdb.connect("data/processed/ball.duckdb", read_only=True)
    tx = dict(con.execute("SELECT work_id, coalesce(title,'') || '. ' || "
                          "coalesce(abstract,'') FROM works WHERE work_id IN ?",
                          [wids]).fetchall())
    con.close()

    print(f"re-judging {len(pool):,} pairs with {args.judge} "
          f"(original judge: {d.get('judge')})", flush=True)
    rel = judge_with([(q, w, tx.get(w, w)) for q, w in sorted(pool)],
                     args.judge, args.gateway)
    print(f"  {len(rel):,} judgments returned\n")

    summary = {}
    for arm, ids in per_query.items():
        ps, ns = [], []
        for q in queries:
            lst = ids.get(q, [])
            ps.append(sum(rel.get((q, w), 0) for w in lst) / len(lst) if lst else 0.0)
            ns.append(ndcg_at_k(lst, rel, q, args.k))
        old = d["summary"].get(arm, {})
        summary[arm] = {"precision_at_10": round(sum(ps) / len(ps), 4),
                        "ndcg_at_10": round(sum(ns) / len(ns), 4),
                        "median_seconds": old.get("median_seconds"),
                        "cost_per_query_usd": old.get("cost_per_query_usd"),
                        "previous_ndcg_same_family_judge": old.get("ndcg_at_10")}
    cis = paired_bootstrap(per_query, queries, rel, args.k, rounds=1000)
    for arm in summary:
        summary[arm].update(cis.get(arm, {}))

    Path(args.out).write_text(json.dumps(
        {"judge": args.judge, "original_judge": d.get("judge"), "k": args.k,
         "queries": queries, "judged_pairs": len(rel), "summary": summary}, indent=2))

    print(f"{'arm':<12} {'P@10':>7} {'nDCG':>7} {'nDCG CI':>16} {'was':>7} {'med s':>7} {'$/q':>8}")
    for arm, v in summary.items():
        ci = v.get("ndcg_ci95", [0, 0])
        print(f"{arm:<12} {v['precision_at_10']:>7.3f} {v['ndcg_at_10']:>7.3f} "
              + f"[{ci[0]:.3f},{ci[1]:.3f}]".rjust(16)
              + f" {v['previous_ndcg_same_family_judge'] or 0:>7.3f}"
                f" {v['median_seconds'] or 0:>7.2f} {v['cost_per_query_usd'] or 0:>8.5f}")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
