# GiveCampus Constituent Intelligence — Final Backend Benchmark

## Result

The complete pipeline was the overall winner:

```text
natural-language query
  -> GPT-5.6 Luna rubric planner
  -> semantic embeddings + BM25 candidate retrieval
  -> Jev scoring over raw scoped constituent fields
  -> weighted rubric aggregation
  -> top 20 constituents
  -> one of: thank-you, event invite, reunion mailer, ask
```

Across the four frozen fundraising queries, the Luna-planned semantic + BM25 + Jev pipeline returned **44 relevant constituents in 80 top-20 slots**, compared with 40 for semantic-only and 37 for semantic + BM25. Its mean NDCG@20 was **0.3956**, compared with 0.3144 and 0.3207.

| System | Relevant top-20 hits | Hits / 80 | Mean NDCG@20 |
|---|---:|---:|---:|
| Semantic-only | 40 | 50.0% | 0.3144 |
| Semantic + BM25 | 37 | 46.3% | 0.3207 |
| **GPT-5.6 Luna + semantic + BM25 + Jev** | **44** | **55.0%** | **0.3956** |

The complete pipeline improved top-20 hits by **10.0% over semantic-only** and **18.9% over semantic + BM25**. Mean NDCG@20 improved by **25.8% over semantic-only** and **23.4% over semantic + BM25**.

## Per-query results

| Fundraising job | Semantic | Semantic + BM25 | Complete pipeline |
|---|---:|---:|---:|
| Lapsed loyal outreach | **12** | 10 | 2 |
| Stewardship before ask | 0 | 1 | **7** |
| Reunion reengagement | 18 | 18 | **19** |
| Upgrade ask review | 10 | 8 | **16** |

The complete pipeline won three of four jobs. Its largest gains were stewardship, where Jev separated recent gifts needing acknowledgment from generic donor matches, and upgrade review, where Luna generated several independent giving, engagement, and outreach-readiness criteria for Jev to score.

The lapsed-loyal query remains the clear weakness. Luna generated six hard gates for that job, and their conjunction was too restrictive. The next improvement is to convert most of those gates into weighted scores or bonuses, retaining hard gates only for contact and solicitation restrictions.

## Architecture and data boundary

GPT-5.6 Luna sees only the natural-language query and the allowlisted field schema. It creates the retrieval phrasings and fundraising rubric; it never sees the constituent pile.

Semantic embeddings and BM25 select a pool of at most 2,000 people from 14,052 eligible constituents. Jev then evaluates Luna's gates, score criteria, and bonuses using only the raw fields named by each criterion. Jev receives no embeddings, similarity scores, BM25 scores, fused ranks, or gold labels. Code combines the weighted Jev results and uses constituent ID only for exact ties.

The figures in this report were measured with a 2,000-person Jev pool. The interactive backend default has subsequently been reduced to **200 candidates**. Hybrid retrieval still ranks the full eligible population; only its top 200 proceed to Jev.

The measured live runner completed all four full-corpus queries in **374.2 seconds**. Jev reranking took 43.3–95.9 seconds per query with criteria evaluated concurrently. Embeddings were cached for constituent cards; only Luna's new retrieval phrasings required new vectors.

## Decision-layer note

After ranking, Jev assigns each selected constituent one supported next action: **thank-you, event invite, reunion mailer, or ask**. Deterministic contact and solicitation permissions remain enforced outside the model. Action-label accuracy is reported separately from ranking quality because several frozen gold labels are `exclude` or `hold_for_review`, which are outside the four-action challenge output.

Full aggregate benchmark: [complex-benchmark-live.md](complex-benchmark-live.md)  
Machine-readable data, including Luna's generated rubrics and telemetry: [complex-benchmark-live.json](complex-benchmark-live.json)

## Latency and projected Claude Opus 5 cost

### Measured latency

| Stage | Four-query total | Average per query |
|---|---:|---:|
| Semantic ranking over cached embeddings | 0.34 s | 0.08 s |
| Luna-phrased semantic + BM25 retrieval | 34.21 s | 8.55 s |
| Jev rubric reranking | 307.19 s | 76.80 s |
| Complete live runner | 374.23 s | 93.56 s |

Jev reranking represented about **82%** of measured runner latency. The benchmark issued 43,132 independent Jev criterion judgments. Their aggregate service latency was 8.19 hours, compressed to 307.2 seconds of wall time through concurrent execution.

On the final-action layer, Jev's measured p50 latency was 170–185 ms and p95 was 223–266 ms. The GPT-5 mini comparison was 734–805 ms p50 and 1.07–1.82 seconds p95. Jev was therefore approximately **4.2x faster at the median** and **4–8x faster at p95** for these short structured decisions.

The 374.2-second runner reused the four Luna-generated rubric plans. A cold run should add roughly the slowest parallel planner call, about 61 seconds, producing an estimated cold end-to-end time of **about 7.3 minutes**.

### Known OpenAI cost

The measured known OpenAI portion was approximately **$0.047**:

| Component | Measured usage | Estimated cost |
|---|---:|---:|
| Constituent and query embeddings | 735,279 input tokens | $0.0147 |
| GPT-5.6 Luna rubric planning, including schema-repair attempts | 6,622 input + 17,598 output | $0.0224 |
| GPT-5 mini top-20 comparison decisions | 29,729 input + 999 output | $0.0094 |

The live Jev rubric run generated 14.61 million input tokens and 1.06 million output tokens across 43,132 calls. At Jev's standard **$42 per billion input tokens**, equivalent to **$0.042 per million**, with free output, the complete Jev reranking and final-action run cost approximately **$0.614**. Reranking alone cost approximately **$0.613**.

Including embeddings, Luna planning, GPT-5 mini comparison decisions, and Jev, the measured model cost was therefore approximately **$0.66**. This excludes any platform subscription or fixed infrastructure charges.

### Claude Opus 5 projection

Claude Opus 5 standard synchronous pricing is $5 per million uncached input tokens and $25 per million output tokens. Adaptive thinking is enabled by default, so reasoning tokens are the main cost driver even when the visible JSON response is small.

An efficient LLM implementation would evaluate all of one constituent's rubric criteria in one request, resulting in 8,000 calls for four queries and 2,000 candidates per query. With little or no caching:

| Scenario | Input per candidate | Reasoning + visible output per candidate | Projected total |
|---|---:|---:|---:|
| Constrained reasoning | 1,000 tokens | 500 + 50 tokens | **$150** |
| High reasoning | 2,000 tokens | 1,500 + 50 tokens | **$390** |
| Very high reasoning | 3,000 tokens | 3,000 + 50 tokens | **$730** |

The **$390 high-reasoning estimate** is the most appropriate planning figure for an uncached Opus 5 reranker here. It consists of about $80 of input and $310 of reasoning/output tokens.

If Opus mirrored Jev's criterion-by-criterion architecture instead of combining each person's criteria into one request, it would make roughly 43,132 calls. Using the measured 14.61 million input tokens and assuming 1,000 reasoning tokens per judgment, the projected cost rises to approximately **$1,178**. At 2,000 reasoning tokens per judgment it rises to approximately **$2,256**. With no reasoning overhead and exactly the measured Jev token volume, the Opus-equivalent floor would still be about **$99.54**.

Claude Opus 5 Fast mode is advertised as roughly 2.5 times faster at twice the base price. The efficient high-reasoning projection would therefore be approximately **$780** in Fast mode. Actual wall time would depend on account rate limits and allowed concurrency; the benchmark does not contain a live Opus 5 latency measurement, so no measured latency-win claim should be made against Opus itself.

## Top-200 production projection

The production default now passes the hybrid top 200 to Jev instead of the top 2,000. These are linear projections from the measured 2,000-candidate run; no new quality benchmark was run.

| Component | Projected per-query result |
|---|---:|
| Full-population hybrid retrieval over 14,052 eligible people | ~8.6 seconds |
| Jev reranking of 200 candidates | ~7.7 seconds |
| Warm end-to-end query, including final top-20 actions | ~20–25 seconds |
| Cold query including Luna rubric planning | ~45–85 seconds |
| Jev input, including the final-action pass | ~0.37M tokens |
| Jev cost at $42/B input and free output | **~$0.016** |
| Total known production model cost | **~$0.02–$0.03** |

The one-time corpus embedding cost remains approximately $0.015 with `text-embedding-3-small` or $0.096 with `text-embedding-3-large`. New query embeddings cost a fraction of a cent. The main unresolved tradeoff is candidate recall at 200: the cost and latency projections are reliable first-order estimates, but the existing benchmark does not establish whether all important prospects survive the smaller retrieval cutoff.
