#!/usr/bin/env python3
"""Is the enrichment column actually right, and is the mean-probability share honest?

Two separate claims get tested here and they fail differently:
  1. Accuracy  -- precision/recall/F1 of Jev at p>=0.5 against labels from a stronger
     model, on a stratified sample so the 2% base rate does not let "always no" win.
  2. Calibration -- whether p means what it says. If it does, the mean probability is
     an unbiased estimate of the true share and is lower-variance than counting
     yes/no answers. If it does not, every trend number is off by the same bias.

Stratified sampling inflates the positive rate on purpose, so precision and recall are
computed with sampling weights to recover corpus-level values.

Writes results/validation.json and results/calibration.png.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import duckdb

JUDGE = os.environ.get("BK_JUDGE_MODEL", "gpt-5.2")
QUESTION = ("Does this research paper use or study large language models, transformer "
            "language models, or LLM-based systems? Other machine learning and "
            "non-language neural networks do NOT count.")


def label(items, workers=8):
    from openai import OpenAI
    client = OpenAI()
    out = {}

    def one(it):
        wid, text = it
        for attempt in range(5):
            try:
                r = client.chat.completions.create(
                    model=JUDGE, temperature=0,
                    messages=[{"role": "user", "content":
                        f"{QUESTION}\n\nPaper:\n{text[:2000]}\n\n"
                        f'Return JSON: {{"answer": true or false}}'}],
                    response_format={"type": "json_object"})
                out[wid] = int(bool(json.loads(r.choices[0].message.content).get("answer")))
                return
            except Exception:
                if attempt == 4:
                    return
                time.sleep(2 ** attempt)

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, items))
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Validate enrichment accuracy and calibration.")
    p.add_argument("--question", default="llm_usage")
    p.add_argument("--db", default="data/processed/ball.duckdb")
    p.add_argument("--n-per-stratum", type=int, default=100)
    args = p.parse_args(argv)

    enr = Path(f"data/processed/enrich_{args.question}.parquet")
    if not enr.exists():
        print(f"error: {enr} missing; run enrich.py first", file=sys.stderr)
        return 1

    con = duckdb.connect(args.db, read_only=True)
    E = f"read_parquet('{enr}')"
    total, corpus_mean = con.execute(f"SELECT count(*), avg(p) FROM {E}").fetchone()

    # Two strata: the model says yes, and the model says no. Sampling them equally
    # gives recall a chance to be measured at all when positives are ~2% of the pile.
    strata = {}
    for name, cond in [("pos", "p >= 0.5"), ("neg", "p < 0.5")]:
        rows = con.execute(f"""
            SELECT e.work_id, w.title, w.abstract, e.p FROM {E} e
            JOIN works w USING (work_id) WHERE {cond}
            ORDER BY hash(e.work_id) LIMIT ?""", [args.n_per_stratum]).fetchall()
        n_stratum = con.execute(f"SELECT count(*) FROM {E} WHERE {cond}").fetchone()[0]
        strata[name] = {"rows": rows, "size": n_stratum,
                        "weight": n_stratum / max(len(rows), 1)}
        print(f"  stratum {name}: {n_stratum:,} in corpus, sampled {len(rows)}")
    con.close()

    items = [(r[0], f"Title: {r[1]}\n\nAbstract: {r[2]}")
             for s in strata.values() for r in s["rows"]]
    print(f"\nlabeling {len(items)} abstracts with {JUDGE}...", flush=True)
    truth = label(items)
    print(f"  got {len(truth)} labels")

    # Weighted confusion matrix: each sampled paper stands for `weight` corpus papers.
    tp = fp = fn = tn = 0.0
    bins = defaultdict(lambda: [0.0, 0.0])   # prob bin -> [weighted n, weighted positives]
    for name, s in strata.items():
        w = s["weight"]
        for wid, _t, _a, pv in s["rows"]:
            y = truth.get(wid)
            if y is None:
                continue
            yhat = pv >= 0.5
            if yhat and y:   tp += w
            elif yhat:       fp += w
            elif y:          fn += w
            else:            tn += w
            b = min(int(pv * 10), 9)
            bins[b][0] += w
            bins[b][1] += w * y

    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    true_share = (tp + fn) / (tp + fp + fn + tn)
    count_share = (tp + fp) / (tp + fp + fn + tn)

    cal = [{"bin": f"{b/10:.1f}-{(b+1)/10:.1f}", "predicted": (b + 0.5) / 10,
            "actual": round(v[1] / v[0], 4) if v[0] else None,
            "weighted_n": round(v[0], 1)}
           for b, v in sorted(bins.items())]

    payload = {
        "question": args.question, "judge": JUDGE, "labeled": len(truth),
        "corpus_size": total,
        "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4),
        "true_share_weighted": round(true_share, 5),
        "mean_probability_estimate": round(corpus_mean, 5),
        "count_estimate": round(count_share, 5),
        "mean_prob_abs_error": round(abs(corpus_mean - true_share), 5),
        "count_abs_error": round(abs(count_share - true_share), 5),
        "calibration": cal,
    }
    res = Path("results"); res.mkdir(exist_ok=True)
    (res / "validation.json").write_text(json.dumps(payload, indent=2))

    print(f"\n  precision {precision:.3f}   recall {recall:.3f}   F1 {f1:.3f}")
    print(f"\n  true share (weighted labels) : {true_share*100:.2f}%")
    print(f"  mean-probability estimate    : {corpus_mean*100:.2f}%  "
          f"(error {abs(corpus_mean-true_share)*100:.2f} pp)")
    print(f"  yes/no count estimate        : {count_share*100:.2f}%  "
          f"(error {abs(count_share-true_share)*100:.2f} pp)")
    better = "mean probability" if abs(corpus_mean - true_share) <= abs(count_share - true_share) else "counting"
    print(f"  -> {better} is the better estimator here")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        pts = [(c["predicted"], c["actual"]) for c in cal if c["actual"] is not None]
        fig, ax = plt.subplots(figsize=(5, 4.6))
        ax.plot([0, 1], [0, 1], "--", c="#94a3b8", label="perfectly calibrated")
        if pts:
            ax.plot([x for x, _ in pts], [y for _, y in pts], "o-", c="#2563eb", label="Jev")
        ax.set_xlabel("Jev probability"); ax.set_ylabel("observed rate")
        ax.set_title(f"Calibration — {args.question}"); ax.legend(); ax.grid(alpha=.3)
        fig.tight_layout(); fig.savefig(res / "calibration.png", dpi=140)
        print(f"\nwrote {res/'validation.json'} and {res/'calibration.png'}")
    except Exception as e:
        print(f"\nwrote JSON; plot skipped: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
