#!/usr/bin/env python3
"""Precision 0.46 is a question-wording problem before it is a model problem.

Jev answers what is literally written, so a loose criterion like "systems built on
them" sweeps in anything that mentions a language model in passing. This tries
several wordings of the same intent against the same judge labels and reports which
one actually separates the classes -- and whether per-item beats packed on truth,
not just on agreement with per-item.

Writes results/question_tuning.json.
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
INTENT = ("Does this research paper use or study large language models, transformer "
          "language models, or LLM-based systems? Other machine learning and "
          "non-language neural networks do NOT count.")

VARIANTS = {
    "original": noul(
        instructions=("Does this research paper use or study large language models, "
                      "transformer language models, or LLM-based systems?"),
        true=("The abstract describes using, training, evaluating, fine-tuning or "
              "studying large language models, transformer models applied to language, "
              "or systems built on top of them."),
        false=("The abstract does not involve large language models. Other machine "
               "learning, other neural networks, and non-language AI count as false."),
    ),
    "strict": noul(
        instructions=("Is a large language model a subject or a component of the work "
                      "described in this abstract?"),
        true=("The work trains, fine-tunes, prompts, evaluates or analyses a large "
              "language model such as GPT, BERT, LLaMA, Claude, or a transformer "
              "trained on text. The language model must be part of the work itself."),
        false=("No large language model is part of the work. This includes papers "
               "about other neural networks, computer vision models, reinforcement "
               "learning, classical machine learning, statistics, or papers that only "
               "mention language models as motivation, related work, or future work."),
    ),
    "named": noul(
        instructions=("Does the work in this abstract involve a large language model "
                      "such as GPT, BERT, LLaMA, T5, Claude, or a similar transformer "
                      "model trained on natural language?"),
        true=("A model of that kind is trained, fine-tuned, prompted, evaluated, or "
              "used as a component of the system the authors built or studied."),
        false=("No such model is involved in the work. Mentioning one only as context, "
               "motivation or related work is false. Other kinds of neural network, "
               "including vision models and protein models, are false."),
    ),
}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Compare question wordings on labeled data.")
    p.add_argument("--db", default="data/processed/ball.duckdb")
    p.add_argument("--n-per-stratum", type=int, default=100)
    p.add_argument("--pack", type=int, default=25)
    args = p.parse_args(argv)

    prior = Path("results/validation.json")
    enr = Path("data/processed/enrich_llm_usage.parquet")
    con = duckdb.connect(args.db, read_only=True)
    E = f"read_parquet('{enr}')"
    rows = []
    for cond in ("p >= 0.5", "p < 0.5"):
        rows += con.execute(f"""
            SELECT e.work_id, w.title, w.abstract, e.p FROM {E} e
            JOIN works w USING (work_id) WHERE {cond}
            ORDER BY hash(e.work_id) LIMIT ?""", [args.n_per_stratum]).fetchall()
    sizes = {c: con.execute(f"SELECT count(*) FROM {E} WHERE {c}").fetchone()[0]
             for c in ("p >= 0.5", "p < 0.5")}
    con.close()

    texts = [f"Title: {r[1]}\n\nAbstract: {r[2]}" for r in rows]
    weights = [sizes["p >= 0.5"] / args.n_per_stratum] * args.n_per_stratum + \
              [sizes["p < 0.5"] / args.n_per_stratum] * args.n_per_stratum
    weights = weights[:len(rows)]

    from openai import OpenAI
    client = OpenAI()
    truth: dict[int, int] = {}

    def lab(i):
        for attempt in range(5):
            try:
                r = client.chat.completions.create(
                    model=JUDGE, temperature=0,
                    messages=[{"role": "user", "content":
                        f"{INTENT}\n\nPaper:\n{texts[i][:2000]}\n\n"
                        f'Return JSON: {{"answer": true or false}}'}],
                    response_format={"type": "json_object"})
                truth[i] = int(bool(json.loads(r.choices[0].message.content).get("answer")))
                return
            except Exception:
                if attempt == 4:
                    return
                time.sleep(2 ** attempt)

    print(f"labeling {len(texts)} abstracts with {JUDGE}...", flush=True)
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lab, range(len(texts))))
    print(f"  {len(truth)} labels\n")

    def score(probs):
        tp = fp = fn = tn = 0.0
        for i, pv in enumerate(probs):
            y = truth.get(i)
            if y is None or pv is None:
                continue
            w = weights[i]
            if pv >= 0.5 and y:   tp += w
            elif pv >= 0.5:       fp += w
            elif y:               fn += w
            else:                 tn += w
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        return {"precision": round(prec, 4), "recall": round(rec, 4),
                "f1": round(2*prec*rec/(prec+rec), 4) if prec + rec else 0.0,
                "count_share": round((tp + fp) / (tp + fp + fn + tn), 5),
                "true_share": round((tp + fn) / (tp + fp + fn + tn), 5)}

    out = {}
    for name, q in VARIANTS.items():
        c = JevClient(workers=8)
        t = time.time()
        ans = c.judge_packed(texts, {"q": q}, per_request=args.pack)
        probs = [p_true(a["q"]) if a.get("q") else None for a in ans]
        u = c.usage.as_dict(); c.close()
        out[f"{name}__packed{args.pack}"] = {**score(probs), "seconds": round(time.time()-t, 1),
                                             "cost_usd": u["cost_usd"]}
        print(f"  {name:<10} packed@{args.pack}  P={out[f'{name}__packed{args.pack}']['precision']:.3f} "
              f"R={out[f'{name}__packed{args.pack}']['recall']:.3f} "
              f"F1={out[f'{name}__packed{args.pack}']['f1']:.3f}")

    # Best wording, judged one item at a time -- does packing cost real accuracy?
    best = max(out, key=lambda k: out[k]["f1"]).split("__")[0]
    c = JevClient(workers=10)
    t = time.time()
    ans = c.judge_per_item(texts, {"q": VARIANTS[best]})
    probs = [p_true(a["q"]) for a in ans]
    u = c.usage.as_dict(); c.close()
    out[f"{best}__per_item"] = {**score(probs), "seconds": round(time.time()-t, 1),
                                "cost_usd": u["cost_usd"]}
    print(f"\n  {best:<10} per-item    P={out[f'{best}__per_item']['precision']:.3f} "
          f"R={out[f'{best}__per_item']['recall']:.3f} F1={out[f'{best}__per_item']['f1']:.3f}")

    res = Path("results"); res.mkdir(exist_ok=True)
    (res / "question_tuning.json").write_text(json.dumps(
        {"judge": JUDGE, "labeled": len(truth), "pack": args.pack, "variants": out}, indent=2))
    print(f"\nbest F1: {max(out, key=lambda k: out[k]['f1'])} "
          f"({max(v['f1'] for v in out.values()):.3f})")
    print(f"wrote {res/'question_tuning.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
