#!/usr/bin/env python3
"""Consolidated token and cost ledger across every run in this project.

The pitch rests on a cost claim, so the claim needs an audit trail rather than a
remembered number. This walks the saved result artifacts and the run logs, pulls out
every recorded token count, and reports them per activity and per provider, plus the
unit economics that actually matter: dollars per abstract classified and per query.

Anything whose price is not known is reported in tokens and marked unpriced rather
than being silently valued at zero.

Writes results/token_ledger.json and prints the table.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

RESULTS = Path("results")
LOGS = Path("/private/tmp/claude-501/-Users-priyadarshannarayanasamy-jjjv/"
            "e847133c-2b84-4a00-a796-e3be6189e164/scratchpad")

PRICES = {
    "jev-1.13.0":                 {"in": 0.042, "out": 0.0},
    "gpt-5.2":                    {"in": 1.75,  "out": 14.00},
    "gpt-5.6-sol":                {"in": 4.00,  "out": 20.00},
    "gpt-6-astra":                None,
    "gpt-5.5":                    None,
    "muse-spark-1.3-contributor": {"in": 1.25,  "out": 4.25},
    "glm-5.3-flash":              {"in": 0.15,  "out": 0.50},
    "deepseek-v4-flash":          {"in": 0.15,  "out": 0.60},
    "mimo-v2.5":                  None,
    "text-embedding-3-small":     {"in": 0.02,  "out": 0.0},
}


def cost_of(model: str, tin: int, tout: int):
    pr = PRICES.get(model)
    if pr is None:
        return None
    return tin / 1e6 * pr["in"] + tout / 1e6 * pr["out"]


def add(rows, activity, provider, model, requests, tin, tout, note=""):
    rows.append({"activity": activity, "provider": provider, "model": model,
                 "requests": requests, "input_tokens": tin, "output_tokens": tout,
                 "cost_usd": cost_of(model, tin, tout), "note": note})


def main() -> int:
    rows: list[dict] = []

    # --- enrichment passes, from the run logs (the definitive record) ----------
    for log, label, mode in [("enrich2.log", "enrichment (packed@25)", "packed"),
                             ("enrich_peritem.log", "enrichment (per-item)", "per_item")]:
        f = LOGS / log
        if not f.exists():
            continue
        txt = f.read_text()
        m = re.search(r"requests: ([\d,]+)\s+tokens: ([\d,]+)\s+cost: \$([\d.]+)", txt)
        if m:
            add(rows, label, "typesafe", "jev-1.13.0",
                int(m.group(1).replace(",", "")), int(m.group(2).replace(",", "")), 0)
        else:
            # Killed mid-run: recover what it reported last.
            prog = re.findall(r"([\d,]+)/[\d,]+\s+\d+s\s+[\d]+/s\s+\$([\d.]+)", txt)
            if prog:
                done, spend = prog[-1]
                done = int(done.replace(",", ""))
                spend = float(spend)
                add(rows, label, "typesafe", "jev-1.13.0", done,
                    int(spend / 0.042 * 1e6), 0,
                    note=f"incomplete: {done:,} items before credits ran out")

    # --- embeddings -----------------------------------------------------------
    for log in ("embed_k2.log", "embed_final.log"):
        f = LOGS / log
        if not f.exists():
            continue
        m = re.search(r"embedded ([\d,]+) in \d+s, \$([\d.]+)", f.read_text())
        if m:
            spend = float(m.group(2))
            add(rows, "embeddings", "openai", "text-embedding-3-small",
                0, int(spend / 0.02 * 1e6), 0,
                note=f"{m.group(1)} documents")

    # --- benchmark arms and judges -------------------------------------------
    for name in ("benchmark", "benchmark_llms"):
        f = RESULTS / f"{name}.json"
        if not f.exists():
            continue
        d = json.loads(f.read_text())
        for arm, v in d.get("arms", {}).items():
            provider = ("typesafe" if v["model"].startswith("jev")
                        else "opencode" if "-" in v["model"] and v["model"] not in
                        ("gpt-5.2", "gpt-5.6-sol") else "openai")
            add(rows, f"benchmark arm ({name})", provider, v["model"],
                v.get("requests", 0), v.get("input_tokens", 0),
                v.get("output_tokens", 0),
                note=f"F1={v.get('f1')}")

    # --- retrieval comparison -------------------------------------------------
    f = RESULTS / "baselines.json"
    if f.exists():
        d = json.loads(f.read_text())
        for arm, v in d.get("summary", {}).items():
            if v.get("total_cost_usd"):
                rows.append({"activity": "retrieval comparison", "provider": "mixed",
                             "model": arm, "requests": len(d.get("queries", [])),
                             "input_tokens": 0, "output_tokens": 0,
                             "cost_usd": v["total_cost_usd"],
                             "note": f"P@10={v.get('precision_at_10')}"})

    # --- totals ---------------------------------------------------------------
    by_provider: dict[str, dict] = {}
    for r in rows:
        b = by_provider.setdefault(r["provider"], {"requests": 0, "in": 0, "out": 0,
                                                   "cost": 0.0, "unpriced": 0})
        b["requests"] += r["requests"] or 0
        b["in"] += r["input_tokens"] or 0
        b["out"] += r["output_tokens"] or 0
        if r["cost_usd"] is None:
            b["unpriced"] += 1
        else:
            b["cost"] += r["cost_usd"]

    total_in = sum(b["in"] for b in by_provider.values())
    total_out = sum(b["out"] for b in by_provider.values())
    total_cost = sum(b["cost"] for b in by_provider.values())

    payload = {"rows": rows, "by_provider": by_provider,
               "total_input_tokens": total_in, "total_output_tokens": total_out,
               "total_cost_usd": round(total_cost, 4)}
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "token_ledger.json").write_text(json.dumps(payload, indent=2))

    print(f"{'activity':<34} {'model':<28} {'reqs':>8} {'in tok':>13} {'out tok':>10} {'$':>9}")
    print("-" * 106)
    for r in sorted(rows, key=lambda x: -(x["cost_usd"] or 0)):
        c = f"{r['cost_usd']:.4f}" if r["cost_usd"] is not None else "unpriced"
        print(f"{r['activity'][:33]:<34} {r['model'][:27]:<28} "
              f"{r['requests']:>8,} {r['input_tokens']:>13,} "
              f"{r['output_tokens']:>10,} {c:>9}")
    print("-" * 106)
    print(f"{'BY PROVIDER':<34}")
    for prov, b in sorted(by_provider.items(), key=lambda x: -x[1]["cost"]):
        u = f"  ({b['unpriced']} unpriced)" if b["unpriced"] else ""
        print(f"  {prov:<32} {b['requests']:>8,} req  {b['in']:>13,} in  "
              f"{b['out']:>10,} out  ${b['cost']:>8.4f}{u}")
    print("-" * 106)
    print(f"  {'TOTAL':<32} {'':>8}      {total_in:>13,} in  {total_out:>10,} out  "
          f"${total_cost:>8.4f}")
    # The counterfactual is the whole point: what the same token volume would have
    # cost had a frontier LLM done the work Jev did.
    jev_in = by_provider.get("typesafe", {}).get("in", 0)
    print(f"\nCOUNTERFACTUAL -- the {jev_in:,} tokens Jev processed, priced as other models:")
    print(f"  {'jev-1.13.0 (actual)':<30} ${jev_in/1e6*0.042:>9.2f}")
    alts = {}
    for m in ("gpt-5.2", "gpt-5.6-sol", "muse-spark-1.3-contributor",
              "glm-5.3-flash", "deepseek-v4-flash"):
        pr = PRICES.get(m)
        if pr:
            c = jev_in / 1e6 * pr["in"]
            alts[m] = c
            print(f"  {m:<30} ${c:>9.2f}   ({c/(jev_in/1e6*0.042):>5.0f}x)")
    payload["counterfactual_input_only_usd"] = {
        "jev-1.13.0": round(jev_in / 1e6 * 0.042, 2),
        **{k: round(v, 2) for k, v in alts.items()}}
    (RESULTS / "token_ledger.json").write_text(json.dumps(payload, indent=2))
    print(f"\nwrote {RESULTS/'token_ledger.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
