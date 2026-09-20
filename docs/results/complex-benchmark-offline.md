# Complex Retrieval Benchmark (Offline)

Frozen gold specification: [complex-benchmark-gold-v1.json](complex-benchmark-gold-v1.json) (SHA-256 `609c2df08875edfef7e5c85d22a2c9a42501f916ae53cd77cf22e8c26bd64e44`).
Cutoff: 2025-08-31. Shared eligible population and item-card candidate pool: 14,052 constituents. No post-cutoff outcomes were loaded. External requests: 0.
BM25 used the exact query string; absent lexical matches rank last by ID. Embedding fusion: not run (no compatible embedding_cache table found; live embedding calls are disabled; 14,052 card vectors and 4 query vectors missing).

Recall@100/500/2,000 uses the grade>0 relevant set. NDCG uses graded gain 2^grade-1. P@20 and R@20 are binary grade>0. MRR is the reciprocal rank of the first relevant result. Counts/actions are aggregates only.

| Query | System | Relevant / N | Recall@100 | Recall@500 | Recall@2k | NDCG@10 | NDCG@20 | P@20 | R@20 | MRR | Hits@20 | Latency ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | bm25 | 3803 / 14052 | 0.0134 | 0.0705 | 0.2319 | 0.0600 | 0.0798 | 0.6500 | 0.0034 | 0.3333 | 13 | 491 |
| q2_stewardship_before_ask | bm25 | 246 / 14052 | 0.0000 | 0.0122 | 0.1220 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0056 | 0 | 453 |
| q3_reunion_reengagement | bm25 | 4009 / 14052 | 0.0172 | 0.0551 | 0.1626 | 0.7760 | 0.6744 | 0.6500 | 0.0032 | 1.0000 | 13 | 310 |
| q4_upgrade_ask_review | bm25 | 979 / 14052 | 0.0327 | 0.0470 | 0.1767 | 0.1429 | 0.1328 | 0.8500 | 0.0174 | 1.0000 | 17 | 390 |

## Gold label counts

| Query | Grade 0 | Grade 1 | Grade 2 | Grade 3 |
|---|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | 10249 | 3508 | 260 | 35 |
| q2_stewardship_before_ask | 13806 | 106 | 55 | 85 |
| q3_reunion_reengagement | 10043 | 4009 | 0 | 0 |
| q4_upgrade_ask_review | 13073 | 898 | 63 | 18 |

Action labels are held-out structured reference labels only; no Jev or LLM action evaluation was run. See the JSON for aggregate action counts and cache coverage.

Total runtime: 12745 ms.
