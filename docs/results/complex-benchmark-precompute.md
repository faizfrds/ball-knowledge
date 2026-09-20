# Complex Retrieval Benchmark (Offline) + Precomputed Jev Characteristics Arm

> Honest scope: the precomputed_characteristics arm ranks by the Jev-materialized yes/no votes from data/characteristics-full (mode=live_jev), whose constituent states were evaluated as-of 2026-08-31 — a YEAR LATER than the 2025-08-31 gold cutoff. The precompute arm is therefore a LEAKY diagnostic; it is not a fair apples-to-apples claim over the other arms. Win or lose, numbers below are computed, not asserted.

Frozen gold specification: [complex-benchmark-gold-v1.json](complex-benchmark-gold-v1.json) (SHA-256 `609c2df08875edfef7e5c85d22a2c9a42501f916ae53cd77cf22e8c26bd64e44`).
Cutoff: 2025-08-31. Shared eligible population and item-card candidate pool: 14,052 constituents. No post-cutoff outcomes were loaded. External requests: 0.
BM25 used the exact query string; absent lexical matches rank last by ID. Embedding fusion: available from local text-embedding-3-small cache only.

Recall@100/500/2,000 uses the grade>0 relevant set. NDCG uses graded gain 2^grade-1. P@20 and R@20 are binary grade>0. MRR is the reciprocal rank of the first relevant result. Counts/actions are aggregates only.

| Query | System | Relevant / N | Recall@100 | Recall@500 | Recall@2k | NDCG@10 | NDCG@20 | P@20 | R@20 | MRR | Hits@20 | Latency ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | bm25 | 3803 / 14052 | 0.0134 | 0.0705 | 0.2319 | 0.0600 | 0.0798 | 0.6500 | 0.0034 | 0.3333 | 13 | 430 |
| q1_lapsed_loyal_engaged | semantic | 3803 / 14052 | 0.0158 | 0.0660 | 0.2374 | 0.1752 | 0.1783 | 0.6000 | 0.0032 | 1.0000 | 12 | 110 |
| q1_lapsed_loyal_engaged | fused_bm25_embedding | 3803 / 14052 | 0.0155 | 0.0786 | 0.2824 | 0.0464 | 0.1042 | 0.4500 | 0.0024 | 0.2000 | 9 | 143 |
| q1_lapsed_loyal_engaged | precomputed_characteristics | 3803 / 14052 | 0.0058 | 0.0305 | 0.1914 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0270 | 0 | 51 |
| q2_stewardship_before_ask | bm25 | 246 / 14052 | 0.0000 | 0.0122 | 0.1220 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0056 | 0 | 348 |
| q2_stewardship_before_ask | semantic | 246 / 14052 | 0.0081 | 0.0406 | 0.1992 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0263 | 0 | 86 |
| q2_stewardship_before_ask | fused_bm25_embedding | 246 / 14052 | 0.0041 | 0.0285 | 0.1220 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0135 | 0 | 115 |
| q2_stewardship_before_ask | precomputed_characteristics | 246 / 14052 | 0.0569 | 0.1829 | 0.4309 | 0.2685 | 0.1784 | 0.2000 | 0.0163 | 0.3333 | 4 | 28 |
| q3_reunion_reengagement | bm25 | 4009 / 14052 | 0.0172 | 0.0551 | 0.1626 | 0.7760 | 0.6744 | 0.6500 | 0.0032 | 1.0000 | 13 | 282 |
| q3_reunion_reengagement | semantic | 4009 / 14052 | 0.0192 | 0.0858 | 0.3405 | 0.9306 | 0.9188 | 0.9000 | 0.0045 | 1.0000 | 18 | 94 |
| q3_reunion_reengagement | fused_bm25_embedding | 4009 / 14052 | 0.0197 | 0.0781 | 0.2751 | 0.9306 | 0.8821 | 0.8500 | 0.0042 | 1.0000 | 17 | 123 |
| q3_reunion_reengagement | precomputed_characteristics | 4009 / 14052 | 0.0057 | 0.0621 | 0.2133 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0156 | 0 | 26 |
| q4_upgrade_ask_review | bm25 | 979 / 14052 | 0.0327 | 0.0470 | 0.1767 | 0.1429 | 0.1328 | 0.8500 | 0.0174 | 1.0000 | 17 | 307 |
| q4_upgrade_ask_review | semantic | 979 / 14052 | 0.0306 | 0.1042 | 0.2850 | 0.1679 | 0.1606 | 0.5000 | 0.0102 | 0.5000 | 10 | 99 |
| q4_upgrade_ask_review | fused_bm25_embedding | 979 / 14052 | 0.0480 | 0.0919 | 0.2594 | 0.2559 | 0.2370 | 0.8500 | 0.0174 | 1.0000 | 17 | 114 |
| q4_upgrade_ask_review | precomputed_characteristics | 979 / 14052 | 0.0255 | 0.1634 | 0.6353 | 0.0273 | 0.0183 | 0.0500 | 0.0010 | 0.1000 | 1 | 21 |

## Gold label counts

| Query | Grade 0 | Grade 1 | Grade 2 | Grade 3 |
|---|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | 10249 | 3508 | 260 | 35 |
| q2_stewardship_before_ask | 13806 | 106 | 55 | 85 |
| q3_reunion_reengagement | 10043 | 4009 | 0 | 0 |
| q4_upgrade_ask_review | 13073 | 898 | 63 | 18 |

Action labels are held-out structured reference labels only; no Jev or LLM action evaluation was run. See the JSON for aggregate action counts and cache coverage.

Total runtime: 20182 ms.
