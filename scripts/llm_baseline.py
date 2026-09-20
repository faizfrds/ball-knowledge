#!/usr/bin/env python3
"""What does the same enrichment cost if an LLM does it instead of Jev?

This is the comparison the whole cost story rests on, so it is run on the SAME
abstracts against the SAME judge labels used to score Jev -- otherwise the two
accuracy numbers are not comparable and the cost ratio means nothing.

Three arms, one question:
  jev_packed    Jev at 25 items per request (throughput setting)
  jev_per_item  Jev one item per request   (accuracy setting)
  llm           a frontier LLM, one item per request, the obvious alternative

Reports precision/recall/F1, wall clock, tokens and dollars for each, plus what each
would cost extrapolated to the full corpus and to 1M abstracts.

Writes results/llm_baseline.json.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import duckdb
from ballknowledge.jev import JevClient, noul, p_true

JUDGE = os.environ.get("BK_JUDGE_MODEL", "gpt-5.2")
LLM = os.environ.get("BK_LLM_ARM", "gpt-5.2")
# Token counts below are measured; the dollar figures depend on this price,
# which must be set from the provider's current rate card -- do not trust a
# hardcoded guess for a model whose pricing has not been checked.
LLM_IN = float(os.environ.get("BK_LLM_PRICE_IN", "0"))    # $ per 1M input tokens
LLM_OUT = float(os.environ.get("BK_LLM_PRICE_OUT", "0"))  # $ per 1M output tokens
INTENT = ("Does this research paper use or study large language models, transformer "
          "language models, or LLM-based systems? Other machine learning and "
          "non-language neural networks do NOT count.")

JEV_Q = noul(
    instructions=("Does this research paper use or study large language models, "
                  "transformer language models, or LLM-based systems?"),
    true=("The abstract describes using, training, evaluating, fine-tuning or "
          "studying large language models, transformer models applied to language, "
          "or systems built on top of them."),
    false=("The abstract does not involve large language models. Other machine "
           "learning, other neural networks, and non-language AI count as false."),
)


def openai_pass(texts, model, prompt_intent, workers=12):
    """One request per item -- the LLM has no batching primitive that preserves
    per-item answers, which is exactly the asymmetry being measured."""
    from openai import OpenAI
    client = OpenAI()
    out: dict[int, float] = {}
    usage = {"in": 0, "out": 0, "calls": 0}

    def one(i):
        for attempt in range(5):
            try:
                r = client.chat.completions.create(
                    model=model, temperature=0,
                    messages=[{"role": "user", "content":
                        f"{prompt_intent}\n\nPaper:\n{texts[i][:2000]}\n\n"
                        f'Return JSON: {{"answer": true or false}}'}],
                    response_format={"type": "json_object"})
                out[i] = float(bool(json.loads(r.choices[0].message.content).get("answer")))
                usage["in"] += r.usage.prompt_tokens
                usage["out"] += r.usage.completion_tokens
                usage["calls"] += 1
                return
            except Exception:
                if attempt == 4:
                    return
                time.sleep(2 ** attempt)

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, range(len(texts))))
    return out, usage


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Jev vs LLM on the same enrichment task.")
    p.add_argument("--db", default="data/processed/ball.duckdb")
    p.add_argument("--n-per-stratum", type=int, default=150)
    p.add_argument("--pack", type=int, default=25)
    args = p.parse_args(argv)

    enr = Path("data/processed/enrich_llm_usage.parquet")
    con = duckdb.connect(args.db, read_only=True)
    E = f"read_parquet('{enr}')"
    rows, weights = [], []
    for cond in ("p >= 0.5", "p < 0.5"):
        got = con.execute(f"""
            SELECT e.work_id, w.title, w.abstract FROM {E} e
            JOIN works w USING (work_id) WHERE {cond}
            ORDER BY hash(e.work_id) LIMIT ?""", [args.n_per_stratum]).fetchall()
        size = con.execute(f"SELECT count(*) FROM {E} WHERE {cond}").fetchone()[0]
        rows += got
        weights += [size / max(len(got), 1)] * len(got)
    corpus_n = con.execute(f"SELECT count(*) FROM {E}").fetchone()[0]
    con.close()

    texts = [f"Title: {r[1]}\n\nAbstract: {r[2]}" for r in rows]
    print(f"{len(texts)} abstracts (stratified), corpus {corpus_n:,}\n", flush=True)

    print(f"labeling with {JUDGE}...", flush=True)
    truth, _ = openai_pass(texts, JUDGE, INTENT)
    print(f"  {len(truth)} labels\n", flush=True)

    def score(probs: dict[int, float]):
        tp = fp = fn = tn = 0.0
        for i in range(len(texts)):
            y, pv = truth.get(i), probs.get(i)
            if y is None or pv is None:
                continue
            w = weights[i]
            if pv >= 0.5 and y >= 0.5:   tp += w
            elif pv >= 0.5:              fp += w
            elif y >= 0.5:               fn += w
            else:                        tn += w
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        return {"precision": round(prec, 4), "recall": round(rec, 4),
                "f1": round(2*prec*rec/(prec+rec), 4) if prec + rec else 0.0}

    arms = {}

    for name, pack in [("jev_packed", args.pack), ("jev_per_item", None)]:
        c = JevClient(workers=10)
        t = time.time()
        if pack:
            ans = c.judge_packed(texts, {"q": JEV_Q}, per_request=pack)
        else:
            ans = c.judge_per_item(texts, {"q": JEV_Q})
        dt = time.time() - t
        probs = {i: p_true(a["q"]) for i, a in enumerate(ans) if a.get("q")}
        u = c.usage.as_dict(); c.close()
        per_item_cost = u["cost_usd"] / len(texts)
        arms[name] = {**score(probs), "seconds": round(dt, 1),
                      "items_per_sec": round(len(texts)/dt, 1),
                      "requests": u["requests"], "input_tokens": u["input_tokens"],
                      "cost_usd": round(u["cost_usd"], 5),
                      "cost_per_1k_items": round(per_item_cost * 1000, 4),
                      "projected_corpus_usd": round(per_item_cost * corpus_n, 2),
                      "projected_1m_usd": round(per_item_cost * 1_000_000, 2)}
        print(f"  {name:<14} P={arms[name]['precision']:.3f} R={arms[name]['recall']:.3f} "
              f"F1={arms[name]['f1']:.3f}  {dt:.1f}s  ${u['cost_usd']:.4f}", flush=True)

    t = time.time()
    probs, u = openai_pass(texts, LLM, INTENT)
    dt = time.time() - t
    cost = u["in"]/1e6*LLM_IN + u["out"]/1e6*LLM_OUT
    per_item_cost = cost / max(len(texts), 1)
    arms["llm"] = {**score(probs), "seconds": round(dt, 1),
                   "items_per_sec": round(len(texts)/dt, 1),
                   "requests": u["calls"], "input_tokens": u["in"],
                   "output_tokens": u["out"], "cost_usd": round(cost, 5),
                   "cost_per_1k_items": round(per_item_cost * 1000, 4),
                   "projected_corpus_usd": round(per_item_cost * corpus_n, 2),
                   "projected_1m_usd": round(per_item_cost * 1_000_000, 2),
                   "model": LLM}
    print(f"  {'llm':<14} P={arms['llm']['precision']:.3f} R={arms['llm']['recall']:.3f} "
          f"F1={arms['llm']['f1']:.3f}  {dt:.1f}s  ${cost:.4f}", flush=True)

    res = Path("results"); res.mkdir(exist_ok=True)
    (res / "llm_baseline.json").write_text(json.dumps(
        {"judge": JUDGE, "llm": LLM, "n": len(texts), "corpus_n": corpus_n,
         "labels": len(truth), "arms": arms}, indent=2))

    print(f"\n{'arm':<14} {'F1':>6} {'$/1k':>9} {'$/1M':>10} {'items/s':>9}")
    for k, v in arms.items():
        print(f"{k:<14} {v['f1']:>6.3f} {v['cost_per_1k_items']:>9.4f} "
              f"{v['projected_1m_usd']:>10.2f} {v['items_per_sec']:>9.1f}")
    if arms["llm"]["cost_per_1k_items"]:
        for k in ("jev_packed", "jev_per_item"):
            r = arms["llm"]["cost_per_1k_items"] / max(arms[k]["cost_per_1k_items"], 1e-9)
            sp = arms[k]["items_per_sec"] / max(arms["llm"]["items_per_sec"], 1e-9)
            print(f"\n{k}: {r:.1f}x cheaper and {sp:.1f}x faster than {LLM}")
    print(f"\nwrote {res/'llm_baseline.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
