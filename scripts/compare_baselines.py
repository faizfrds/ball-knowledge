#!/usr/bin/env python3
"""Does the rubric+Jev pipeline actually beat the obvious alternatives?

Four arms over the same queries and the same corpus:
  bm25       keyword search over the same corpus (the standard IR baseline, and
             properly controlled -- same documents, so differences are method, not corpus)
  openalex   OpenAlex's own keyword search, when its shared free budget allows
  semantic   embeddings only, top-k by cosine
  llm_rerank an LLM reranks the top 100 from semantic -- what most teams build
  ball       rubric -> hybrid retrieval -> Jev gate over the deep pool -> ranked

Relevance is judged by POOLING: take the top 10 from every arm, judge each distinct
(query, paper) pair once with a stronger model than any arm uses, then score every
arm against the same pool. That is the standard way to avoid crowning whichever
system the judge happens to resemble, and it means no arm is judged on documents the
others never had a chance to return.

Writes results/baselines.json and results/baselines.png.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import duckdb

QUERIES = [
    "MIT groups using machine learning on neural recordings who also build hardware",
    "work on protein structure prediction that uses deep learning",
    "quantum computing experiments with superconducting qubits, not theory",
    "robotics research involving soft actuators or compliant materials",
    "climate modeling work that assimilates satellite observations",
    "battery materials research using computational screening",
    "papers that apply large language models to biology or chemistry",
    "causal inference methods applied to economics or policy evaluation",
    "photonic integrated circuits for communication, built and measured",
    "CRISPR gene editing delivery methods in living animals",
    "reinforcement learning applied to real physical robots, not simulation",
    "microfluidic devices for single cell analysis",
    "fairness or bias auditing of deployed machine learning systems",
    "materials discovered or characterized with electron microscopy",
    "wearable sensors that measure physiological signals continuously",
    "cryptography research on zero knowledge proofs",
    "urban mobility or transportation network optimization",
    "immunotherapy research involving T cell engineering",
    "energy grid optimization under renewable intermittency",
    "speech or audio models trained on large datasets",
]

JUDGE_MODEL = os.environ.get("BK_JUDGE_MODEL", "gpt-5.2")


def openalex_search(query: str, k: int = 10) -> tuple[list[str], float]:
    t = time.time()
    q = urllib.parse.urlencode({
        "filter": "authorships.institutions.lineage:I63966007,from_publication_date:2015-01-01",
        "search": query, "per-page": k, "select": "id,title",
        "mailto": "nspd@terpmail.umd.edu",
    })
    try:
        with urllib.request.urlopen(f"https://api.openalex.org/works?{q}", timeout=60) as r:
            d = json.load(r)
        ids = [w["id"].rsplit("/", 1)[-1] for w in d["results"]]
    except Exception as e:
        print(f"    openalex failed: {type(e).__name__}", file=sys.stderr)
        ids = []
    return ids, time.time() - t


def ndcg_at_k(ranked: list[str], rel: dict, query: str, k: int) -> float:
    """nDCG rewards putting relevant results near the top, which P@10 cannot see --
    two arms with the same P@10 can differ a lot in what the user reads first."""
    gains = [rel.get((query, w), 0) for w in ranked[:k]]
    dcg = sum(g / math.log2(i + 2) for i, g in enumerate(gains))
    ideal = sorted((rel.get((query, w), 0) for w in ranked), reverse=True)[:k]
    idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal))
    return dcg / idcg if idcg else 0.0


def paired_bootstrap(per_query: dict, queries: list, rel: dict, k: int,
                     rounds: int = 1000, seed: int = 7) -> dict:
    """Resample QUERIES (not documents) -- queries are the unit of variation in
    retrieval, and every arm is scored on the same resample so arms are compared on
    shared noise rather than as independent estimates."""
    rng = random.Random(seed)
    arms = list(per_query)
    acc = {a: {"p": [], "n": []} for a in arms}
    wins = {a: 0 for a in arms}
    for _ in range(rounds):
        sample = [queries[rng.randrange(len(queries))] for _ in queries]
        best, best_v = None, -1.0
        for a in arms:
            ps, ns = [], []
            for q in sample:
                ids = per_query[a].get(q, [])
                ps.append(sum(rel.get((q, w), 0) for w in ids) / len(ids) if ids else 0.0)
                ns.append(ndcg_at_k(ids, rel, q, k))
            mp, mn = sum(ps) / len(ps), sum(ns) / len(ns)
            acc[a]["p"].append(mp)
            acc[a]["n"].append(mn)
            if mn > best_v:
                best, best_v = a, mn
        if best:
            wins[best] += 1
    out = {}
    for a in arms:
        pv, nv = sorted(acc[a]["p"]), sorted(acc[a]["n"])
        out[a] = {
            "p_at_k_ci95": [round(pv[int(.025*len(pv))], 4), round(pv[int(.975*len(pv))], 4)],
            "ndcg_ci95": [round(nv[int(.025*len(nv))], 4), round(nv[int(.975*len(nv))], 4)],
            "win_rate_ndcg": round(wins[a] / rounds, 4),
        }
    return out


def judge(pairs: list[tuple[str, str, str]], workers: int = 8) -> dict[tuple[str, str], int]:
    """Judge (query, work_id, text) triples for relevance. 1 = relevant, 0 = not.

    Judged one pair at a time and blind to which arm produced it, so no arm can be
    favoured by presentation order."""
    from openai import OpenAI
    client = OpenAI()
    out: dict[tuple[str, str], int] = {}

    def one(item):
        query, wid, text = item
        for attempt in range(5):
            try:
                r = client.chat.completions.create(
                    model=JUDGE_MODEL, temperature=0,
                    messages=[{"role": "user", "content":
                        f'Search query: "{query}"\n\nPaper:\n{text[:1500]}\n\n'
                        f"Is this paper a relevant answer to the query? Judge strictly: "
                        f"every specific condition in the query must hold. "
                        f'Return JSON: {{"relevant": true or false}}'}],
                    response_format={"type": "json_object"})
                out[(query, wid)] = int(bool(json.loads(r.choices[0].message.content).get("relevant")))
                return
            except Exception:
                if attempt == 4:
                    out[(query, wid)] = 0
                    return
                time.sleep(2 ** attempt)

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, pairs))
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Compare Ball Knowledge against baselines.")
    p.add_argument("--db", default="data/processed/ball.duckdb")
    p.add_argument("--n-queries", type=int, default=len(QUERIES))
    p.add_argument("--pool", type=int, default=20_000)
    p.add_argument("--k", type=int, default=10)
    p.add_argument("--arms", default="bm25,semantic,ball")
    p.add_argument("--bootstrap", type=int, default=1000)
    args = p.parse_args(argv)

    from ballknowledge.engine import Engine
    from ballknowledge.index import HybridIndex
    from ballknowledge.rubric import LLMUsage

    queries = QUERIES[:args.n_queries]
    arms = args.arms.split(",")
    eng = Engine(db=args.db)
    idx = HybridIndex.load("data/processed")
    con = duckdb.connect(args.db, read_only=True)

    def texts_for(ids: list[str]) -> dict[str, str]:
        if not ids:
            return {}
        rows = con.execute(
            "SELECT work_id, coalesce(title,'') || '. ' || coalesce(abstract,'') "
            "FROM works WHERE work_id IN ?", [ids]).fetchall()
        return dict(rows)

    runs: dict[str, dict] = {a: {"per_query": {}, "seconds": [], "cost": 0.0} for a in arms}

    for qi, query in enumerate(queries):
        print(f"\n[{qi+1}/{len(queries)}] {query}", flush=True)

        if "openalex" in arms:
            ids, dt = openalex_search(query, args.k)
            runs["openalex"]["per_query"][query] = ids
            runs["openalex"]["seconds"].append(dt)
            print(f"  openalex   {len(ids):>2} results  {dt:.2f}s")

        if "bm25" in arms:
            t = time.time()
            rows = idx.sparse([query], args.k)[0]
            ids = [idx.ids[i] for i in rows][:args.k]
            dt = time.time() - t
            runs["bm25"]["per_query"][query] = ids
            runs["bm25"]["seconds"].append(dt)
            print(f"  bm25       {len(ids):>2} results  {dt:.2f}s")

        if "semantic" in arms:
            t = time.time()
            ids = idx.search([query], top_k=args.k)
            dt = time.time() - t
            runs["semantic"]["per_query"][query] = ids
            runs["semantic"]["seconds"].append(dt)
            # embedding one query is ~10 tokens; cost is rounding error but recorded
            runs["semantic"]["cost"] += 10 / 1e6 * 0.02
            print(f"  semantic   {len(ids):>2} results  {dt:.2f}s")

        if "llm_rerank" in arms:
            t = time.time()
            cand = idx.search([query], top_k=100)
            tx = texts_for(cand)
            from openai import OpenAI
            listing = "\n".join(f"{i}. {tx.get(w,'')[:250]}" for i, w in enumerate(cand))
            u = LLMUsage()
            try:
                r = OpenAI().chat.completions.create(
                    model=os.environ.get("BK_LLM_ARM", "gpt-5.2"), temperature=0,
                    messages=[{"role": "user", "content":
                        f'Query: "{query}"\n\nCandidates:\n{listing}\n\n'
                        f"Return the {args.k} most relevant candidate numbers, best first. "
                        f'JSON: {{"ranking": [numbers]}}'}],
                    response_format={"type": "json_object"})
                u.add(r)
                order = json.loads(r.choices[0].message.content).get("ranking", [])
                ids = [cand[i] for i in order if isinstance(i, int) and 0 <= i < len(cand)][:args.k]
            except Exception as e:
                print(f"    llm_rerank failed: {type(e).__name__}")
                ids = cand[:args.k]
            dt = time.time() - t
            runs["llm_rerank"]["per_query"][query] = ids
            runs["llm_rerank"]["seconds"].append(dt)
            runs["llm_rerank"]["cost"] += u.cost_usd
            print(f"  llm_rerank {len(ids):>2} results  {dt:.2f}s  ${u.cost_usd:.4f}")

        if "ball" in arms:
            t = time.time()
            try:
                out = eng.search(query, top_k=args.k, pool=args.pool)
                ids = [r["work_id"] for r in out["results"]]
                cost = out["receipt"]["total_cost_usd"]
                cands = out["receipt"]["candidates"]
            except Exception as e:
                print(f"    ball failed: {type(e).__name__}: {str(e)[:160]}")
                ids, cost, cands = [], 0.0, 0
            dt = time.time() - t
            runs["ball"]["per_query"][query] = ids
            runs["ball"]["seconds"].append(dt)
            runs["ball"]["cost"] += cost
            print(f"  ball       {len(ids):>2} results  {dt:.2f}s  ${cost:.4f}  "
                  f"(pool {cands:,})")

    # Pool every arm's top-k, judge each distinct pair once.
    pool: set[tuple[str, str]] = set()
    for a in arms:
        for q, ids in runs[a]["per_query"].items():
            pool.update((q, w) for w in ids)
    all_ids = sorted({w for _, w in pool})
    tx = texts_for(all_ids)
    # OpenAlex can return works outside our corpus; judge them on title alone.
    triples = [(q, w, tx.get(w, w)) for q, w in sorted(pool)]
    print(f"\njudging {len(triples):,} distinct (query, paper) pairs with {JUDGE_MODEL}...",
          flush=True)
    rel = judge(triples)

    summary = {}
    for a in arms:
        ps, ns, cov = [], [], 0
        for q in queries:
            ids = runs[a]["per_query"].get(q, [])
            if not ids:
                ps.append(0.0)
                ns.append(0.0)
                continue
            cov += 1
            ps.append(sum(rel.get((q, w), 0) for w in ids) / len(ids))
            ns.append(ndcg_at_k(ids, rel, q, args.k))
        secs = sorted(runs[a]["seconds"] or [0])
        summary[a] = {
            "precision_at_10": round(sum(ps) / max(len(ps), 1), 4),
            "ndcg_at_10": round(sum(ns) / max(len(ns), 1), 4),
            "median_seconds": round(secs[len(secs) // 2], 2),
            "p95_seconds": round(secs[min(int(.95 * len(secs)), len(secs) - 1)], 2),
            "total_cost_usd": round(runs[a]["cost"], 4),
            "cost_per_query_usd": round(runs[a]["cost"] / max(len(queries), 1), 5),
            "queries_with_results": cov,
        }
    cis = paired_bootstrap({a: runs[a]["per_query"] for a in arms}, queries, rel,
                           args.k, rounds=args.bootstrap)
    for a in arms:
        summary[a].update(cis[a])

    con.close()
    res = Path("results"); res.mkdir(exist_ok=True)
    (res / "baselines.json").write_text(json.dumps(
        {"queries": queries, "judge": JUDGE_MODEL, "k": args.k,
         "judged_pairs": len(triples), "summary": summary,
         "per_query": {a: runs[a]["per_query"] for a in arms}}, indent=2))

    print(f"\n{'arm':<12} {'P@10':>7} {'nDCG':>7} {'nDCG 95% CI':>16} "
          f"{'med s':>7} {'p95 s':>7} {'$/query':>9}")
    for a in arms:
        v = summary[a]
        ci = v["ndcg_ci95"]
        print(f"{a:<12} {v['precision_at_10']:>7.3f} {v['ndcg_at_10']:>7.3f} "
              + f"[{ci[0]:.3f},{ci[1]:.3f}]".rjust(16)
              + f" {v['median_seconds']:>7.2f} {v['p95_seconds']:>7.2f} "
                f"{v['cost_per_query_usd']:>9.5f}")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(1, 3, figsize=(13, 3.8))
        colors = ["#94a3b8", "#60a5fa", "#f59e0b", "#2563eb"]
        for i, (key, label) in enumerate([("ndcg_at_10", f"nDCG@{args.k}"),
                                          ("median_seconds", "Median latency (s)"),
                                          ("cost_per_query_usd", "Cost per query ($)")]):
            vals = [summary[a][key] for a in arms]
            ax[i].bar(arms, vals, color=colors[:len(arms)])
            ax[i].set_title(label); ax[i].tick_params(axis="x", rotation=20)
            ax[i].grid(axis="y", alpha=.3)
        fig.suptitle(f"Ball Knowledge vs baselines — {len(queries)} queries, "
                     f"judged by {JUDGE_MODEL}")
        fig.tight_layout(); fig.savefig(res / "baselines.png", dpi=140)
        print(f"\nwrote {res/'baselines.json'} and {res/'baselines.png'}")
    except Exception as e:
        print(f"\nwrote JSON; plot skipped: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
