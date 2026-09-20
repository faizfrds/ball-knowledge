# Ball Knowledge — build log
Started 2026-09-20 ~03:20. Target: demo-able by 07:00.

## Validated dependencies (all green, 04:05)
- OpenAI embeddings `text-embedding-3-small` — 1536 dims, OK
- OpenAI chat `gpt-4o-mini` — OK (replaces Anthropic; no ANTHROPIC_API_KEY available)
- TypeSafe Jev `jev-1.13.0` — OK after fixing malformed `.env` (was `TYPESAFI_API_KEY=TYPESAFE_API_KEY=…\``)

## Hard facts measured, not assumed
- MIT works 2015–2026: 152,713 pulled in 399 s (counts match OpenAlex group_by exactly)
- MIT works 2000–2026: 269,971 total, 205,283 with abstracts
- Corpus: 326 MB gz / 2.18 GB raw JSON / 135 MB abstract text
- MIT authors 2015+: 58,229 distinct; 28,151 with >=2 papers; 151,977 co-author edges
- Jev limits (docs): $0.042/M input, output free, 1,200 req/min, 250k tok/s, 64k ctx (state+longest question <= 32k)

## The load-bearing question
Docs: one request = one state = one answer set; "fan-out" = many questions about ONE item.
So **requests/min binds, not tokens/s**:
- packed 100 items/request -> 1M abstracts = 10k req = ~8 min  (plan's claim holds)
- per-item             -> 1M abstracts = 1M req = ~14 h      (plan's claim off by 100x)
`scripts/validate_packing.py` settles it. Cost (~$16/1M) holds either way.

## Status
- [x] Pull MIT 2015–2026
- [x] Normalize -> Parquet + DuckDB (works, authorships)
- [ ] Backfill 2000–2014
- [ ] Co-author groups (Louvain) — sort bug fixed, rerun pending
- [ ] Packing validation
- [ ] Embeddings (OpenAI, ~205k abstracts, ~$1.20)
- [ ] BM25 index
- [ ] Engine: router, rubric compiler, retrieve, gate, score, rank, receipt
- [ ] API + UI

## Measured results (06:45)

### Enrichment throughput (packed@25)
112,779 abstracts in **243 s (464/s)**, 4,512 requests, 48.4M tokens, **$2.03**.
Extrapolates to 1M abstracts = ~36 min, ~$18.

### Packing sweep (results/packing_sweep.{json,png})
| items/req | agreement w/ per-item | prob drift | throughput |
|---|---|---|---|
| 10 | 97.5% | 0.035 | 111/s |
| 25 | 98.0% | 0.051 | 213/s |
| 50 | 91.5% | 0.142 | 244/s |
| 100 | 80.5% | 0.255 | 132/s |
| 150 | max_tokens_exceeded (32k state cap) | | |

### Accuracy vs gpt-4o labels (results/validation.json, question_tuning.json)
| mode | precision | recall | F1 |
|---|---|---|---|
| packed@25 | 0.735 | 0.334 | 0.459 |
| per-item | **0.939** | 0.427 | **0.587** |

**The agreement metric above was misleading.** At a 1.5% base rate it is dominated by
true negatives. Against balanced ground truth, packing costs ~20 precision points.
Rewording the question three ways did not recover it -- batching is the cause.

### Share estimator -- the design doc is wrong here
True share (weighted labels) 1.73%. Mean-probability estimate 5.59% (**error 3.85 pp**).
Yes/no count estimate 1.61% (**error 0.12 pp**). Jev's probabilities are NOT calibrated
on this question; they run high. **Use counting, not mean probability**, and treat the
trend chart's absolute levels accordingly.

Recall is 0.43 even per-item: Jev misses over half of true LLM papers. The trend's
*shape* is trustworthy, its *level* is a lower bound.

## Status
- [x] MIT 2015-2026: 152,713 works, normalized, DuckDB
- [x] 497 research groups from co-authorship (weight>=3, resolution 15, median 16 members)
- [x] Enrichment pass + trend by year and field
- [x] Packing sweep, accuracy validation, question tuning, calibration plot
- [x] FastAPI + UI serving (trends, groups)
- [ ] Embeddings: 20,480/118,354 at 06:45, TPM-bound, ETA ~07:20
- [ ] Deep search end-to-end (blocked on embeddings)
- [ ] Baseline comparison (blocked on embeddings)
- [ ] Backfill 2000-2014: abandoned after repeated OpenAlex 429s
