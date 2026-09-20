#!/usr/bin/env python3
"""Turn unstructured abstracts into new structured columns, corpus-wide.

This is the enrichment pass: one Jev question asked of every paper, producing a
column that did not exist in OpenAlex. Shares are estimated as the MEAN PROBABILITY
rather than by counting yes/no answers -- with calibrated probabilities that is the
lower-variance estimator, and it does not throw away the model's uncertainty.

Resumable: answered work_ids are appended to a JSONL as they land, and a re-run
skips them. Writes data/processed/enrich_<name>.parquet and results/enrich_<name>.json.

  python scripts/enrich.py --question llm_usage
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
import pyarrow as pa
import pyarrow.parquet as pq
from ballknowledge.jev import JevClient, noul, p_true

QUESTIONS = {
    "llm_usage": noul(
        instructions=("Does this research paper use or study large language models, "
                      "transformer language models, or LLM-based systems?"),
        true=("The abstract describes using, training, evaluating, fine-tuning or "
              "studying large language models, transformer models applied to language, "
              "or systems built on top of them."),
        false=("The abstract does not involve large language models. Other machine "
               "learning, other neural networks, and non-language AI count as false."),
    ),
    "uses_ml": noul(
        instructions="Does this research paper use machine learning as a method?",
        true="The work trains, applies or evaluates a machine learning model of any kind.",
        false="The work uses no machine learning, or only mentions it as related work.",
    ),
    "builds_hardware": noul(
        instructions=("Does this research paper build or fabricate physical hardware, "
                      "a device, or an instrument?"),
        true=("The authors fabricated, built or physically prototyped a device, chip, "
              "instrument, robot or material system."),
        false=("The work is purely computational, theoretical, or an analysis of data "
               "collected elsewhere."),
    ),
    "clinical": noul(
        instructions="Does this research paper involve human subjects or clinical data?",
        true="The work studies human participants, patients, or human clinical data.",
        false="The work involves no human subjects or human clinical data.",
    ),
}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Run one Jev question over the whole corpus.")
    p.add_argument("--question", default="llm_usage", choices=sorted(QUESTIONS))
    p.add_argument("--db", default="data/processed/ball.duckdb")
    p.add_argument("--pack", type=int, default=25,
                   help="items per request; ignored when --per-item is set")
    p.add_argument("--per-item", action="store_true",
                   help="one request per item. Slower, but the benchmark puts packed@25 "
                        "at F1 0.723 against per-item's 0.966, with non-overlapping CIs.")
    p.add_argument("--workers", type=int, default=16)
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--since", type=int, default=2000)
    args = p.parse_args(argv)

    if not os.environ.get("TYPESAFE_API_KEY"):
        print("error: TYPESAFE_API_KEY not set", file=sys.stderr)
        return 2

    con = duckdb.connect(args.db, read_only=True)
    q = ("SELECT work_id, title, abstract, publication_year, field, subfield "
         "FROM works WHERE abstract IS NOT NULL AND publication_year >= ? "
         "ORDER BY work_id")
    if args.limit:
        q += f" LIMIT {args.limit}"
    rows = con.execute(q, [args.since]).fetchall()
    con.close()

    suffix = "_peritem" if args.per_item else ""
    cache = Path(f"data/processed/enrich_{args.question}{suffix}.jsonl")
    done: dict[str, float] = {}
    if cache.exists():
        for line in cache.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                done[d["work_id"]] = d["p"]
        print(f"resuming: {len(done):,} already answered")

    todo = [r for r in rows if r[0] not in done]
    print(f"corpus: {len(rows):,} papers, {len(todo):,} to answer, "
          f"pack={args.pack}, question={args.question}", flush=True)

    if todo:
        texts = [f"Title: {r[1]}\n\nAbstract: {r[2]}" for r in todo]
        jev = JevClient(workers=args.workers)
        t0 = time.time()
        written = [0]
        fh = cache.open("a")

        def on_result(i: int, ans: dict) -> None:
            a = ans.get(args.question) or next(iter(ans.values()), None)
            if a is None:
                return
            fh.write(json.dumps({"work_id": todo[i][0], "p": p_true(a)}) + "\n")
            written[0] += 1
            if written[0] % 5000 == 0:
                el = time.time() - t0
                fh.flush()
                print(f"  {written[0]:,}/{len(todo):,}  {el:.0f}s  "
                      f"{written[0]/max(el,1e-9):.0f}/s  "
                      f"${jev.usage.cost_usd:.2f}", flush=True)

        if args.per_item:
            jev.judge_per_item(texts, {args.question: QUESTIONS[args.question]},
                               on_result=on_result)
        else:
            jev.judge_packed(texts, {args.question: QUESTIONS[args.question]},
                             per_request=args.pack, on_result=on_result)
        fh.close()
        el = time.time() - t0
        u = jev.usage.as_dict()
        jev.close()
        print(f"\nanswered {written[0]:,} in {el:.0f}s ({written[0]/max(el,1e-9):.0f}/s)")
        print(f"requests: {u['requests']:,}  tokens: {u['input_tokens']:,}  "
              f"cost: ${u['cost_usd']:.2f}")
        for line in cache.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                done[d["work_id"]] = d["p"]
        stats = {"seconds": round(el, 1), "items": written[0], **u}
    else:
        stats = {"seconds": 0, "items": 0}

    meta = {r[0]: r for r in rows}
    tbl = [{"work_id": w, "p": pv, "publication_year": meta[w][3],
            "field": meta[w][4], "subfield": meta[w][5]}
           for w, pv in done.items() if w in meta]
    out = Path("data/processed") / f"enrich_{args.question}{suffix}.parquet"
    pq.write_table(pa.Table.from_pylist(tbl), out, compression="zstd")

    # Share by field by year, estimated as mean probability.
    con = duckdb.connect()
    con.execute(f"CREATE VIEW e AS SELECT * FROM read_parquet('{out}')")
    # Two estimators, because they disagree and one of them is wrong. Measured on
    # labelled data: averaging probabilities overstated the true share by 3.85 pp
    # while counting yes/no was off by 0.12 pp. `share` is therefore the count.
    by_year = con.execute("""
        SELECT publication_year, count(*) AS n,
               avg(CASE WHEN p >= 0.5 THEN 1.0 ELSE 0.0 END) AS count_share,
               avg(p) AS mean_p
        FROM e GROUP BY 1 ORDER BY 1""").fetchall()
    by_field = con.execute("""
        SELECT field, count(*) AS n,
               avg(CASE WHEN p >= 0.5 THEN 1.0 ELSE 0.0 END) AS count_share
        FROM e WHERE field IS NOT NULL GROUP BY 1 HAVING count(*) >= 200
        ORDER BY count_share DESC LIMIT 12""").fetchall()
    con.close()

    res = Path("results"); res.mkdir(exist_ok=True)
    payload = {"question": args.question, "n": len(tbl), "stats": stats,
               "estimator": "count of p>=0.5 (mean probability is reported alongside "
                            "but is not used: it overstated a labelled share by 3.85 pp)",
               "by_year": [{"year": y, "n": n, "share": round(cs, 4),
                            "mean_prob_share": round(mp, 4),
                            "count": int(round(cs * n))} for y, n, cs, mp in by_year],
               "by_field": [{"field": f, "n": n, "share": round(cs, 4)}
                            for f, n, cs in by_field]}
    (res / f"enrich_{args.question}{suffix}.json").write_text(json.dumps(payload, indent=2))

    print(f"\n{args.question} share by year (mean probability):")
    for y, n, cs, mp in by_year:
        if y and y >= 2015:
            print(f"  {y}  {cs*100:5.1f}%  of {n:>6,}   ({int(round(cs*n)):>4,} papers)"
                  f"   [mean-prob would say {mp*100:.1f}%]")
    print(f"\ntop fields:")
    for f, n, cs in by_field[:6]:
        print(f"  {cs*100:5.1f}%  {f} ({n:,})")
    print(f"\nwrote {out} and {res/f'enrich_{args.question}{suffix}.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
