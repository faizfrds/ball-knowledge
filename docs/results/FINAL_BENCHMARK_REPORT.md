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

The measured live runner completed all four full-corpus queries in **374.2 seconds**. Jev reranking took 43.3–95.9 seconds per query with criteria evaluated concurrently. Embeddings were cached for constituent cards; only Luna's new retrieval phrasings required new vectors.

## Decision-layer note

After ranking, Jev assigns each selected constituent one supported next action: **thank-you, event invite, reunion mailer, or ask**. Deterministic contact and solicitation permissions remain enforced outside the model. Action-label accuracy is reported separately from ranking quality because several frozen gold labels are `exclude` or `hold_for_review`, which are outside the four-action challenge output.

Full aggregate benchmark: [complex-benchmark-live.md](complex-benchmark-live.md)  
Machine-readable data, including Luna's generated rubrics and telemetry: [complex-benchmark-live.json](complex-benchmark-live.json)
