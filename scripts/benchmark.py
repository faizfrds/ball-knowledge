#!/usr/bin/env python3
"""Research-grade comparison of Jev against frontier LLMs on the enrichment task.

Three things make a comparison like this mean something, and all three are easy to
skip:

1. A gold standard that is not one of the contestants. Scoring LLM arms with an LLM
   judge is circular. Here TWO strong models that are NOT arms label every item
   independently; items they agree on become gold, and items they disagree on are
   reported as ambiguous rather than quietly resolved in someone's favour. Cohen's
   kappa states how reliable that gold set actually is instead of assuming it.

2. Stratified sampling with weights. The positive rate is under 2%, so a uniform
   sample would contain almost no positives and "always say no" would score 98%.
   Sampling the two strata equally and re-weighting recovers corpus-level precision
   and recall while giving recall something to measure.

3. Significance. A three-point gap over a few hundred items is noise. Every metric
   gets a paired bootstrap confidence interval, and arms are compared on the same
   resamples so the comparison is paired rather than two independent estimates.

Metrics per arm: precision, recall, F1 (weighted, with CIs), wall clock, throughput,
p50/p95 request latency, input and output tokens, dollars, and dollars projected to
the full corpus and to 1M items.

Writes results/benchmark.json and results/benchmark.png.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import duckdb
from ballknowledge.jev import JevClient, noul, p_true

# Dollars per million tokens. A model with no entry cannot be priced, and the script
# reports its tokens while refusing to invent a cost for it.
PRICES = {
    "jev-1.13.0":        {"in": 0.042, "out": 0.0},
    "gpt-5.2":           {"in": 1.75,  "out": 14.00},
    "gpt-5.6-sol":       {"in": 4.00,  "out": 20.00},
    # Meta's published rate for Muse Spark on the Meta Model API.
    "muse-spark-1.3-contributor": {"in": 1.25, "out": 4.25},
    # OpenCode Zen published rates for the flash tiers.
    "glm-5.3-flash":     {"in": 0.15,  "out": 0.50},
    "deepseek-v4-flash": {"in": 0.15,  "out": 0.60},
}
JUDGES = ["gpt-6-astra", "gpt-5.5"]          # deliberately not among the arms

# Arms reached through OpenAI's own API.
OPENAI_ARMS = ["gpt-5.2", "gpt-5.6-sol"]
# Arms reached through the OpenCode Zen gateway. Cheap open models belong in a
# benchmark as a FLOOR: they show the task is not trivially easy. They are not a
# substitute for a frontier comparison and are never presented as one.
OPENCODE_BASE = "https://opencode.ai/zen/go/v1"
# muse-spark-1.{2,3}-contributor are listed by the gateway but return
# "Upstream request failed: Endpoint is unavailable" on every call, so they are
# excluded rather than left to burn twelve minutes in retries.
OPENCODE_ARMS = ["glm-5.3-flash", "deepseek-v4-flash", "mimo-v2.5"]

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


def price(model: str) -> dict | None:
    env_in, env_out = os.environ.get(f"PRICE_IN_{model}"), os.environ.get(f"PRICE_OUT_{model}")
    if env_in or env_out:
        return {"in": float(env_in or 0), "out": float(env_out or 0)}
    return PRICES.get(model)


def openai_pass(texts, model, workers=12, gateway=False):
    """One request per item. An LLM has no batching primitive that returns per-item
    answers, which is precisely the asymmetry being measured."""
    from openai import OpenAI
    if gateway:
        # The Zen gateway refuses to route without a session header.
        client = OpenAI(api_key=os.environ["OPENCODE_API_KEY"],
                        base_url=OPENCODE_BASE,
                        default_headers={"x-opencode-session": "ball-knowledge-bench"})
    else:
        client = OpenAI()
    out: dict[int, float] = {}
    tok = {"in": 0, "out": 0, "calls": 0}
    lat: list[float] = []
    import threading
    lock = threading.Lock()

    def one(i):
        for attempt in range(5):
            try:
                t0 = time.perf_counter()
                r = client.chat.completions.create(
                    model=model,
                    messages=[{"role": "user", "content":
                        f"{INTENT}\n\nPaper:\n{texts[i][:2000]}\n\n"
                        f'Return JSON: {{"answer": true or false}}'}],
                    response_format={"type": "json_object"})
                dt = time.perf_counter() - t0
                raw = r.choices[0].message.content or ""
                # Smaller models wrap JSON in prose or code fences.
                if "{" in raw:
                    raw = raw[raw.index("{"):raw.rindex("}") + 1]
                ans = json.loads(raw).get("answer")
                with lock:
                    out[i] = float(bool(ans))
                    tok["in"] += r.usage.prompt_tokens
                    tok["out"] += r.usage.completion_tokens
                    tok["calls"] += 1
                    lat.append(dt)
                return
            except Exception as e:
                if "unavailable" in str(e).lower() or "not_found" in str(e).lower():
                    return          # endpoint is down; retrying cannot help
                if attempt == 4:
                    return
                time.sleep(2 ** attempt)

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, range(len(texts))))
    return out, tok, lat


def kappa(a: dict[int, float], b: dict[int, float]) -> tuple[float, float, int]:
    """Cohen's kappa between two labelers, plus raw agreement and overlap size."""
    keys = sorted(set(a) & set(b))
    if not keys:
        return 0.0, 0.0, 0
    pa = sum((a[k] >= .5) == (b[k] >= .5) for k in keys) / len(keys)
    ca, cb = Counter(a[k] >= .5 for k in keys), Counter(b[k] >= .5 for k in keys)
    pe = sum((ca[v] / len(keys)) * (cb[v] / len(keys)) for v in (True, False))
    return ((pa - pe) / (1 - pe) if pe < 1 else 0.0), pa, len(keys)


def prf(preds: dict[int, float], gold: dict[int, int], weights: list[float],
        idx: list[int]) -> tuple[float, float, float]:
    tp = fp = fn = tn = 0.0
    for i in idx:
        y, pv = gold.get(i), preds.get(i)
        if y is None or pv is None:
            continue
        w = weights[i]
        if pv >= 0.5 and y:   tp += w
        elif pv >= 0.5:       fp += w
        elif y:               fn += w
        else:                 tn += w
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def bootstrap(arms: dict, gold: dict, weights: list[float], n_items: int,
              rounds: int = 1000, seed: int = 7):
    """Paired bootstrap: every arm is scored on the SAME resample each round, so the
    differences between arms are estimated on shared noise rather than separately."""
    rng = random.Random(seed)
    acc = {k: {"precision": [], "recall": [], "f1": []} for k in arms}
    wins = {k: 0 for k in arms}
    for _ in range(rounds):
        idx = [rng.randrange(n_items) for _ in range(n_items)]
        best, best_f1 = None, -1.0
        for k, preds in arms.items():
            p, r, f = prf(preds, gold, weights, idx)
            acc[k]["precision"].append(p)
            acc[k]["recall"].append(r)
            acc[k]["f1"].append(f)
            if f > best_f1:
                best, best_f1 = k, f
        if best:
            wins[best] += 1
    out = {}
    for k, m in acc.items():
        out[k] = {f"{name}_ci95": [round(sorted(v)[int(.025 * len(v))], 4),
                                   round(sorted(v)[int(.975 * len(v))], 4)]
                  for name, v in m.items()}
        out[k]["win_rate_f1"] = round(wins[k] / rounds, 4)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Benchmark Jev vs frontier LLMs.")
    ap.add_argument("--db", default="data/processed/ball.duckdb")
    ap.add_argument("--n-per-stratum", type=int, default=150)
    ap.add_argument("--pack", type=int, default=25)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--bootstrap", type=int, default=1000)
    ap.add_argument("--skip-jev", action="store_true",
                    help="run only the LLM arms (e.g. while Jev credits are out)")
    ap.add_argument("--out", default="benchmark",
                    help="basename under results/ so partial runs do not overwrite")
    args = ap.parse_args(argv)

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
    n = len(texts)
    print(f"{n} abstracts, stratified; corpus {corpus_n:,}\n", flush=True)

    # --- gold standard from two non-contestant judges -------------------------
    judgments = {}
    for j in JUDGES:
        print(f"judging with {j}...", flush=True)
        lab, tok, _ = openai_pass(texts, j, workers=args.workers)
        judgments[j] = lab
        print(f"  {len(lab)} labels, {tok['in']:,} in / {tok['out']:,} out tokens",
              flush=True)

    k, raw_agree, overlap = kappa(judgments[JUDGES[0]], judgments[JUDGES[1]])
    gold = {i: int(judgments[JUDGES[0]][i] >= .5)
            for i in judgments[JUDGES[0]]
            if i in judgments[JUDGES[1]]
            and (judgments[JUDGES[0]][i] >= .5) == (judgments[JUDGES[1]][i] >= .5)}
    ambiguous = overlap - len(gold)
    print(f"\ngold: {len(gold)} agreed, {ambiguous} ambiguous (excluded)")
    print(f"  Cohen's kappa = {k:.3f}, raw agreement = {raw_agree:.1%}\n", flush=True)

    arms: dict[str, dict] = {}
    preds: dict[str, dict] = {}

    # --- Jev arms -------------------------------------------------------------
    jev_specs = ([] if args.skip_jev
                 else [(f"jev_packed{args.pack}", args.pack), ("jev_per_item", None)])
    for name, pack in jev_specs:
        c = JevClient(workers=args.workers)
        t0 = time.time()
        ans = (c.judge_packed(texts, {"q": JEV_Q}, per_request=pack) if pack
               else c.judge_per_item(texts, {"q": JEV_Q}))
        dt = time.time() - t0
        preds[name] = {i: p_true(a["q"]) for i, a in enumerate(ans) if a.get("q")}
        u = c.usage.as_dict(); c.close()
        pr = price("jev-1.13.0")
        cost = u["input_tokens"] / 1e6 * pr["in"] + u["output_tokens"] / 1e6 * pr["out"]
        arms[name] = {"model": "jev-1.13.0", "seconds": round(dt, 1),
                      "items_per_sec": round(n / dt, 1), "requests": u["requests"],
                      "input_tokens": u["input_tokens"], "output_tokens": u["output_tokens"],
                      "latency_p50": u["latency_p50"], "latency_p95": u["latency_p95"],
                      "cost_usd": round(cost, 6), "priced": True,
                      "cost_per_1k": round(cost / n * 1000, 5),
                      "projected_corpus_usd": round(cost / n * corpus_n, 2),
                      "projected_1m_usd": round(cost / n * 1e6, 2)}
        print(f"  {name:<16} {dt:6.1f}s  {n/dt:6.1f}/s  {u['requests']:>4} req  "
              f"${cost:.4f}", flush=True)

    # --- LLM arms -------------------------------------------------------------
    llm_arms = [(m, False) for m in OPENAI_ARMS]
    if os.environ.get("OPENCODE_API_KEY"):
        llm_arms += [(m, True) for m in OPENCODE_ARMS]
    for m, via_gateway in llm_arms:
        t0 = time.time()
        p_out, tok, lat = openai_pass(texts, m, workers=args.workers,
                                      gateway=via_gateway)
        dt = time.time() - t0
        preds[m] = p_out
        pr = price(m)
        cost = (tok["in"] / 1e6 * pr["in"] + tok["out"] / 1e6 * pr["out"]) if pr else None
        lat_sorted = sorted(lat) or [0]
        arms[m] = {"model": m, "seconds": round(dt, 1),
                   "items_per_sec": round(n / dt, 1), "requests": tok["calls"],
                   "input_tokens": tok["in"], "output_tokens": tok["out"],
                   "latency_p50": round(statistics.median(lat_sorted), 3),
                   "latency_p95": round(lat_sorted[min(int(.95*len(lat_sorted)), len(lat_sorted)-1)], 3),
                   "cost_usd": round(cost, 6) if cost is not None else None,
                   "priced": cost is not None,
                   "cost_per_1k": round(cost / n * 1000, 5) if cost is not None else None,
                   "projected_corpus_usd": round(cost / n * corpus_n, 2) if cost is not None else None,
                   "projected_1m_usd": round(cost / n * 1e6, 2) if cost is not None else None}
        c_str = f"${cost:.4f}" if cost is not None else "UNPRICED"
        print(f"  {m:<16} {dt:6.1f}s  {n/dt:6.1f}/s  {tok['calls']:>4} req  {c_str}",
              flush=True)

    # --- accuracy on gold, with paired bootstrap ------------------------------
    keep = sorted(gold)
    for name in arms:
        p, r, f = prf(preds[name], gold, weights, keep)
        arms[name].update({"precision": round(p, 4), "recall": round(r, 4),
                           "f1": round(f, 4)})
    cis = bootstrap({k: preds[k] for k in arms}, gold, weights, len(keep),
                    rounds=args.bootstrap)
    for name in arms:
        arms[name].update(cis[name])

    res = Path("results"); res.mkdir(exist_ok=True)
    payload = {"n_sampled": n, "gold_size": len(gold), "ambiguous": ambiguous,
               "judges": JUDGES, "cohens_kappa": round(k, 4),
               "raw_judge_agreement": round(raw_agree, 4),
               "corpus_n": corpus_n, "bootstrap_rounds": args.bootstrap,
               "prices_used": {a: price(arms[a]["model"]) for a in arms},
               "arms": arms}
    (res / f"{args.out}.json").write_text(json.dumps(payload, indent=2))

    print(f"\n{'arm':<16} {'P':>6} {'R':>6} {'F1':>6} {'F1 95% CI':>16} "
          f"{'p50 s':>7} {'items/s':>8} {'$/1M':>10}")
    for a, v in arms.items():
        ci = v.get("f1_ci95", [0, 0])
        cost = f"{v['projected_1m_usd']:.2f}" if v.get("projected_1m_usd") is not None else "n/a"
        print(f"{a:<16} {v['precision']:>6.3f} {v['recall']:>6.3f} {v['f1']:>6.3f} "
              f"[{ci[0]:.3f},{ci[1]:.3f}]".rjust(16) +
              f" {v['latency_p50']:>7.2f} {v['items_per_sec']:>8.1f} {cost:>10}")

    base = next((a for a in arms if a == "jev_per_item"), None)
    if base and arms[base].get("projected_1m_usd"):
        for m, _ in llm_arms:
            if arms.get(m, {}).get("projected_1m_usd"):
                ratio = arms[m]["projected_1m_usd"] / arms[base]["projected_1m_usd"]
                sp = arms[base]["items_per_sec"] / max(arms[m]["items_per_sec"], 1e-9)
                print(f"\n{base} vs {m}: {ratio:.0f}x cheaper, {sp:.1f}x faster")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        names = list(arms)
        fig, ax = plt.subplots(1, 4, figsize=(17, 4))
        f1s = [arms[a]["f1"] for a in names]
        errs = [[arms[a]["f1"] - arms[a]["f1_ci95"][0] for a in names],
                [arms[a]["f1_ci95"][1] - arms[a]["f1"] for a in names]]
        ax[0].bar(names, f1s, yerr=errs, capsize=4, color="#2563eb")
        ax[0].set_title("F1 (95% CI, paired bootstrap)")
        ax[1].bar(names, [arms[a]["items_per_sec"] for a in names], color="#059669")
        ax[1].set_title("Throughput (items/s)"); ax[1].set_yscale("log")
        ax[2].bar(names, [arms[a]["latency_p50"] for a in names], color="#f59e0b")
        ax[2].set_title("Median request latency (s)")
        costs = [arms[a]["projected_1m_usd"] or 0 for a in names]
        ax[3].bar(names, costs, color="#dc2626")
        ax[3].set_title("Projected $ per 1M items"); ax[3].set_yscale("log")
        for a_ in ax:
            a_.tick_params(axis="x", rotation=25); a_.grid(axis="y", alpha=.3)
        fig.suptitle(f"Enrichment benchmark — {len(gold)} gold items "
                     f"(2 judges, kappa={k:.2f})")
        fig.tight_layout(); fig.savefig(res / "benchmark.png", dpi=140)
        print(f"\nwrote {res/'benchmark.json'} and {res/'benchmark.png'}")
    except Exception as e:
        print(f"\nwrote JSON; plot skipped: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
