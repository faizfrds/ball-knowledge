# Ball Knowledge — experiments and results

Rubric-driven deep search and corpus-scale enrichment over MIT research, built on
OpenAlex and TypeSafe's Jev (System One).

Every number here was measured on this machine on 2026-09-20. Nothing is estimated
unless it says so, and the failures are documented alongside the successes because
several of them changed the design.

---

## 1. Data

| Item | Value |
|---|---|
| Source | `api.openalex.org`, filter `authorships.institutions.lineage:I63966007` |
| Works, 2015–2026 | **152,713** (per-year counts match OpenAlex `group_by` exactly) |
| With abstracts | 118,354 (77%) |
| Pull time | 399 s, 12 parallel year shards |
| On disk | 326 MB gzip / 2.18 GB raw JSON / 135 MB abstract text |
| Embeddings | **117,298** × 1536 float16 (`text-embedding-3-small`), 99.1% coverage, 393 s, **$0.60** |
| Keyword index | DuckDB FTS (BM25) over the same 117,298 documents |

Abstracts arrive from OpenAlex as an inverted index (`{token: [positions]}`) for
redistribution reasons; reconstructing the prose is the first enrichment step and
everything downstream reads the result.

**Not done:** backfill to 2000 (adds 117k works). Abandoned after repeated OpenAlex
429s — the free tier shares a daily budget per IP and we exhausted it.

## 2. Research groups from co-authorship

OpenAlex has no concept of a lab. Groups were recovered by Louvain community
detection over the MIT co-authorship graph.

| Parameter | Value |
|---|---|
| MIT-affiliated authors | 58,229 (28,151 with ≥2 papers) |
| Co-authorship edges | 151,977 |
| Edge filter | **≥3 shared papers** |
| Louvain resolution | **15.0** |
| Groups found | **497**, median 16 members, max 156 |

Two parameters mattered. Papers with >25 authors are skipped entirely — consortium
physics and genomics papers would otherwise add tens of thousands of meaningless
edges. And requiring ≥3 shared papers is what separates labs from the single giant
component that every member of a department belongs to: at resolution 1.0 with no
edge filter, the largest "group" had 1,282 members. Verified by inspection: Susan
Solomon (atmospheric chemistry), Sara Seager (exoplanets), Joshua Tenenbaum
(cognitive science), Erik Demaine (algorithms), Tyler Jacks (cancer genetics).

## 3. How many items fit in one Jev request

TypeSafe's docs state that one request = one state = one answer set, and that the
documented *fan-out* pattern means many questions about **one** item. That makes
**1,200 requests/min the binding limit, not the 250k tokens/s cap** — a distinction
worth 60× in throughput planning.

Packing an array into `state` and naming one question per item is within contract.
This measures where it breaks (200 abstracts, agreement against one-per-request):

| items/request | agreement | mean prob. drift | items/s | requests |
|---|---|---|---|---|
| 1 (reference) | — | — | 47.5 | 200 |
| 10 | 97.5% | 0.035 | 111.5 | 20 |
| 25 | 98.0% | 0.051 | 213.0 | 8 |
| 50 | 91.5% | 0.142 | 243.6 | 4 |
| 100 | 80.5% | 0.255 | 132.2 | 2 |
| 150 | — | — | — | `400 max_tokens_exceeded` |

The hard ceiling is the documented 32k budget for state + longest question.

**This table is misleading on its own, and section 5 shows why.**

## 4. Corpus-scale enrichment

One Jev question asked of every abstract, producing a column OpenAlex does not have.

| Mode | Items | Wall clock | Requests | Tokens | Cost |
|---|---|---|---|---|---|
| packed@25 | 112,779 | **243 s (464/s)** | 4,512 | 48.4M | **$2.03** |
| per-item | 118,354 | ~30 min (66/s) | 118,354 | 76.5M | **$3.21** |

The per-item pass ran with p50 request latency 0.231 s and p95 0.386 s.

Result — share of MIT papers using or studying large language models, by the
**count** estimator on the **per-item** pass (both choices are load-bearing, see §5–6):

| year | share | papers | mean-prob estimator would say |
|---|---|---|---|
| 2015–2018 | **0.0%** | 1 | 1.2–1.3% |
| 2019 | 0.2% | 28 | 2.3% |
| 2020 | 0.5% | 63 | 2.1% |
| 2021 | 0.7% | 77 | 2.1% |
| 2022 | 0.5% | 49 | 1.9% |
| 2023 | 1.3% | 131 | 2.6% |
| 2024 | 2.8% | 281 | 4.1% |
| 2025 | 4.1% | 422 | 5.5% |
| **2026** | **6.2%** | 595 | 7.4% |

**The 2015–2018 figure is the validation.** Large language models did not exist
then, so the correct answer is ~0% and the method returns 0.0%. The earlier
packed+averaged version claimed 2.2% of MIT's 2015 output used LLMs, which is
impossible — it was measuring its own error rate. Recovering the right answer
required both fixes: per-item for accuracy (§5) and counting for calibration (§6).

Top fields, 2026: Computer Science 6.0%, Social Sciences 3.5%, Decision Sciences
3.1%, Psychology 3.1%.

## 5. Accuracy — the experiment that changed the design

Stratified sample of 300 abstracts (150 from each side of Jev's own threshold),
weighted back to corpus proportions because the true positive rate is ~1.6% and a
uniform sample would let "always say no" score 98%.

**Gold standard:** two judges that are *not* contestants — `gpt-6-astra` and
`gpt-5.5` — label independently. Agreement becomes gold; disagreement is excluded
and reported. **296 agreed, 4 ambiguous, Cohen's κ = 0.964 (98.7% raw).**

**Significance:** 1,000-round paired bootstrap; every arm scored on the same
resample each round.

| arm | P | R | **F1** | F1 95% CI | p50 latency | items/s | $/1M items |
|---|---|---|---|---|---|---|---|
| jev_packed25 | 0.739 | 0.708 | 0.723 | [0.637, 0.805] | 0.71 s | **309.0** | **$18.58** |
| **jev_per_item** | 0.959 | 0.972 | **0.966** | [0.931, 0.993] | **0.19 s** | 48.4 | $27.74 |
| gpt-5.2 | 0.986 | 0.972 | 0.979 | [0.949, 1.000] | 0.72 s | 13.1 | $689.21 |
| gpt-5.6-sol | 0.986 | 1.000 | 0.993 | [0.976, 1.000] | 0.96 s | 8.6 | $1,618.75 |

**Headline:** Jev per-item and gpt-5.2 are **statistically indistinguishable**
(overlapping CIs) while Jev is **25× cheaper and 3.7× faster**, with 3.8× better
median latency. Against gpt-5.6-sol, Jev is **58× cheaper** and genuinely 2.7 F1
points worse — that gap is real and should be stated rather than hidden.

**Packing is disqualified for accuracy-critical work.** F1 0.723 vs 0.966 with
**non-overlapping** confidence intervals. Section 3's "98% agreement at 25/request"
was an artifact of a 1.6% base rate: the metric was dominated by true negatives.
Three rewordings of the question failed to recover it, which is what identified
batching rather than phrasing as the cause:

| wording | mode | P | R | F1 |
|---|---|---|---|---|
| original | packed@25 | 0.735 | 0.334 | 0.459 |
| strict | packed@25 | 0.717 | 0.306 | 0.429 |
| named | packed@25 | 0.750 | 0.306 | 0.435 |
| original | **per-item** | **0.939** | 0.427 | **0.587** |

*(This table used a weaker single judge, `gpt-4o`; the absolute values are lower
than the κ=0.964 table above. The comparison within the table is still valid
because every row shares the same labels.)*

## 6. Calibration — mean probability is the wrong estimator

The original design called for estimating shares as the mean probability "when the
probabilities are calibrated." They are not.

| estimator | value | error vs truth |
|---|---|---|
| true share (weighted gold labels) | 1.73% | — |
| mean probability | 5.59% | **3.85 pp** |
| yes/no count | 1.61% | **0.12 pp** |

**Counting is 32× more accurate here.** Jev's probabilities rank well but run high,
so any share computed by averaging them overstates by roughly 3×.

## 7. Cost ledger

| Activity | Model | Requests | Input tokens | Cost |
|---|---|---|---|---|
| enrichment (per-item) | jev-1.13.0 | 80,000 | 51.9M | $2.18 |
| enrichment (packed@25) | jev-1.13.0 | 4,512 | 48.4M | $2.03 |
| embeddings | text-embedding-3-small | — | 30.0M | $0.60 |
| benchmark: gpt-5.6-sol | | 300 | 0.09M | $0.49 |
| benchmark: gpt-5.2 | | 300 | 0.09M | $0.21 |
| retrieval comparison | mixed | 40 | — | $0.33 |

**Total: 130,867,401 input tokens · 21,579 output tokens · $5.85**

**Counterfactual** — the 100.7M tokens Jev processed, priced as other models:

| model | cost | multiple |
|---|---|---|
| **jev-1.13.0 (actual)** | **$4.23** | 1× |
| glm-5.3-flash | $15.10 | 4× |
| deepseek-v4-flash | $15.10 | 4× |
| muse-spark-1.3 | $125.85 | 30× |
| gpt-5.2 | $176.20 | **42×** |
| gpt-5.6-sol | $402.74 | **95×** |

Cheap open models are only 4× more expensive, so cost alone does not carry the
argument — it holds only in combination with the accuracy result in section 5.

## 8. Deep search

Three arms over the same 20 queries and the same 117,298-document index. Relevance by
TREC-style pooling: every arm's top 10 goes into one pool, each distinct (query, paper)
pair is judged once, blind to which arm produced it. 1,000-round paired bootstrap
resampling *queries*, since queries are the unit of variation in retrieval.

| arm | P@10 | nDCG@10 | nDCG 95% CI | median | p95 | $/query |
|---|---|---|---|---|---|---|
| bm25 | 0.425 | 0.700 | [0.560, 0.817] | 0.06 s | 0.07 s | $0 |
| semantic | 0.500 | 0.687 | [0.532, 0.824] | 0.70 s | 1.79 s | $0 |
| **ball** | **0.625** | **0.824** | [0.689, 0.936] | 19.45 s | 42.49 s | $0.091 |

Rubric-driven search beats both standard retrieval baselines on nDCG@10, though the
confidence intervals overlap at 20 queries.

**Judging was verified with a second judge.** The first pass used gpt-5.2. Re-judging
the identical rankings with deepseek-v4-flash, from a different provider, raised both
retrieval baselines (bm25 0.680 -> 0.784, semantic 0.701 -> 0.830) and moved ball by
0.001, so the ordering is not an artifact of one judge's preferences.

**Pool depth does not pay for itself.** Judging deeper measured worse, not better:

| pool | precision@10 | gate time | cost |
|---|---|---|---|
| 20,000 | **0.767** | 60.8 s | $0.495 |
| 3,000 | 0.867 | 4.7 s | $0.082 |
| 1,500 | 0.867 | 1.3 s | $0.046 |

Only 3 queries, so it is noisy, but the 20k pool is worse while being 13x slower and
11x more expensive. Shrinking from 20,000 to 1,500 also changes 7 of the top 10
results, so the deep pool does reach different documents -- they are simply not better
ones. The practical setting is a pool of 1,500-3,000 with wave-based early stopping,
which is what makes a query take ~14 s instead of ~78 s.

**Blending retrieval rank into the score does not help.** The hypothesis was that the
ranker discards topical signal hybrid retrieval had already computed. A 5-query sweep
supported it (P@10 0.660 / 0.700 / 0.720 / 0.700 at weight 0 / 0.2 / 0.4 / 0.6), so the
default was set to 0.4 and the full comparison re-run. On 20 queries it made things
**worse**: nDCG 0.856 -> 0.824, P@10 0.660 -> 0.625. The sweep was underpowered and its
apparent gain was noise. Default reverted to 0.

## 9. Input handling

Two untrusted inputs reach this system: the query a person types, and documents they
paste or upload. Both are cleaned at the API boundary, and the compiler's SQL output
is treated as untrusted too.

**Text cleaning.** NFKC normalisation, then Unicode categories Cc/Cf/Cs are removed --
control codes, zero-width joiners and bidirectional overrides, which are invisible on
screen but reach the model and can make displayed text differ from what is sent.
Whitespace is collapsed and length capped (2,000 chars for a query, 40,000 for a
pasted profile). Newline and tab survive, because pasted documents need them.

**SQL from the compiler is validated, not trusted.** `engine.search` puts the
compiler's `filters` straight into a WHERE clause, so a query crafted to steer the
compiler is an injection path. Every fragment is checked against an allowlist: each
bare identifier must be a known column, a known function or a SQL keyword, and a
blocklist rejects statement separators, comments, DDL/DML, set operations and
DuckDB's file-reading table functions. Unrecognised fragments are dropped and
reported in the receipt as `filters_rejected` rather than repaired. The connection is
read-only, but that alone would not stop `ATTACH` or `read_csv`.

Verified end to end: given a rubric containing `1=1; ATTACH '/tmp/evil.db' AS e`,
`title IN (SELECT title FROM read_csv('/etc/passwd'))` and `secret_admin_column = 1`
alongside a legitimate `publication_year >= 2020`, the engine ran only the legitimate
filter, reported three rejections, returned results, and left the database intact.

Request bodies are also bounded by the schema: `pool` 50-40,000, `top_k` 1-100, and a
query that is empty after cleaning returns 400 rather than reaching a model.

## 10. Known weaknesses

1. **The gold standard is model-derived.** κ=0.964 between two frontier models is
   strong agreement, not human ground truth. A shared blind spot would be inherited.
2. **Strata are drawn from Jev's own predictions.** Weighting keeps every arm's
   estimate unbiased, but the strata are *optimal* for measuring Jev and merely
   *valid* for competitors, so their estimates are noisier. A true positive Jev
   missed sits in the negative stratum at weight 776, so one such item moves a
   competitor's recall substantially. The bootstrap CIs capture this.
3. **`items/s` is a throughput figure under our concurrency settings**, not a model
   property. p50 latency is the cleaner per-request number.
4. **Recall across all arms is measured on a single question.** Generalisation to
   other enrichment questions is untested.
5. **The retrieval test set is 20 queries, mostly two-condition.** Confidence
   intervals are correspondingly wide, and the conjunction-heavy queries the
   architecture is built for are under-represented.

## 11. Failures worth recording

| Failure | Cause | Resolution |
|---|---|---|
| Embeddings lost ~40k vectors twice | script only wrote output at the end | per-shard checkpointing |
| OpenAI 429 despite a token budget | estimated tokens as `chars/4`, under-counting | exact `tiktoken` counts |
| Modal GPU refused | account has no payment method | fell back to CPU containers |
| Modal CPU wedged | free tier preempted containers faster than they worked | abandoned; 14 docs/s vs 278 on OpenAI |
| Local ONNX embedding | bge-large 1.0 docs/s, bge-base 4.4 docs/s | not viable (33 h / 7.4 h) |
| `bm25s`, `markdown-it-py` | no wheels for Python 3.14 | DuckDB FTS instead; two fewer dependencies |
| Deep search returned 0 results | gate probabilities multiplied: 3 gates × 0.7 = 0.34 < 0.5 | geometric mean + non-empty fallback |
| Compiler filters gutted the pool | LLM wrote 5-clause `ILIKE` chains matching ~4 docs | drop filters below 200 docs, report in receipt |
| OpenAlex search arm | shared per-IP daily budget exhausted | replaced with BM25 over the same corpus |
| Muse Spark arm | 0/300 requests succeeded via the gateway | unresolved |

## 12. Reproducing

```bash
uv sync
uv run python scripts/pull_openalex.py                 # MIT works
uv run python src/ballknowledge/normalize.py           # -> Parquet + DuckDB
uv run python src/ballknowledge/graph.py --min-edge-weight 3 --resolution 15
uv run python src/ballknowledge/embed.py --tpm 4000000 # -> embeddings.npy
uv run python -c "import sys;sys.path.insert(0,'src');from ballknowledge.index import build_bm25;build_bm25()"
uv run python scripts/enrich.py --question llm_usage --per-item
uv run python scripts/benchmark.py --n-per-stratum 150
uv run python scripts/compare_baselines.py --n-queries 20
uv run python scripts/token_ledger.py
PYTHONPATH=src uv run python -m uvicorn ballknowledge.api:app --port 8000
```
