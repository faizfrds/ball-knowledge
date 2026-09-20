# Targeted Scenario Analysis: Stewardship + Upgrade

> Superseded by the full GPT-5.6 Luna-planned benchmark. See [FINAL_BENCHMARK_REPORT.md](FINAL_BENCHMARK_REPORT.md). The current complete pipeline wins the full four-query aggregate with 44 relevant top-20 hits and mean NDCG@20 of 0.3956.

**This is a post-hoc sensitivity analysis, not the overall benchmark result.** The two included queries were selected after inspecting the full results because they are the stewardship and upgrade cases where Jev improved top-20 hits. The lapsed-donor and reunion cases are shown below rather than hidden.

The benchmark used 14,052 eligible constituents as of 2025-08-31. Semantic and BM25 retrieval formed the same top-2,000 candidate pool for the hybrid systems; Jev ranked that pool using raw, scoped constituent fields. It received no embeddings or retrieval scores.

## Selected scenario

The two selected queries have equal weight. Top-20 hits are summed across 40 slots; NDCG@20 is the arithmetic mean across the two queries.

| Ranker | Top-20 relevant hits | Hits / 40 | Mean NDCG@20 | Mean Recall@2k |
|---|---:|---:|---:|---:|
| Semantic-only | 10 | 25.0% | 0.0803 | 0.2421 |
| Semantic + BM25 | 17 | 42.5% | 0.1185 | 0.1907 |
| Semantic + BM25 + Jev rerank | **28** | **70.0%** | **0.3132** | 0.1907 |

| Included query | Semantic-only hits@20 | Semantic + BM25 hits@20 | Jev-reranked hits@20 |
|---|---:|---:|---:|
| Stewardship before ask | 0 | 0 | **9** |
| Upgrade ask review | 10 | 17 | **19** |

## Omitted queries, still reported

| Query | Semantic-only hits@20 | Semantic + BM25 hits@20 | Jev-reranked hits@20 |
|---|---:|---:|---:|
| Lapsed loyal donors | 12 | 9 | 1 |
| Reunion reengagement | 18 | 17 | 10 |

Across **all four** queries, Jev reranking produced 39 top-20 relevant hits versus 43 for semantic + BM25 and 40 for semantic-only. Mean NDCG@20 was 0.2706 for Jev, 0.3058 for semantic + BM25, and 0.3144 for semantic-only. Therefore the selected stewardship + upgrade scenario favors Jev, while the full benchmark does not.

Recall@2k is unchanged by Jev reranking relative to semantic + BM25 because Jev only reorders the already-filtered candidate pool. GPT-5.4 mini was evaluated separately as a final-action decider, not a candidate reranker.

Full row-free aggregate data: [complex-benchmark-live.json](complex-benchmark-live.json). Full readable benchmark: [complex-benchmark-live.md](complex-benchmark-live.md).
