# Full-Corpus Live Fundraising Benchmark

Frozen query set: [complex-benchmark-gold-v1.json](complex-benchmark-gold-v1.json). Cutoff 2025-08-31; eligible population 14,052.
Semantic-only ranks the full population. Semantic+BM25 filters a shared top-2,000 pool; Jev scores and reranks every candidate using scoped raw fields, then Jev and OpenAI make final action choices for the Jev top 20. No model receives embeddings or retrieval scores.

OpenAI final-action model: `gpt-5.4-mini-2026-03-17`. Jev reranker model: `jev-1.13.0`.

| Query | Ranker | Relevant / N | Recall@100 | Recall@500 | Recall@2k | NDCG@10 | NDCG@20 | P@20 | Hits@20 | Rank ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | semanticOnly | 3803 / 14052 | 0.0158 | 0.0660 | 0.2374 | 0.1752 | 0.1783 | 0.6000 | 12 | 86 |
| q1_lapsed_loyal_engaged | semanticPlusBm25 | 3803 / 14052 | 0.0155 | 0.0786 | 0.2824 | 0.0464 | 0.1042 | 0.4500 | 9 | 394 |
| q1_lapsed_loyal_engaged | semanticPlusBm25Jev | 3803 / 14052 | 0.0034 | 0.0555 | 0.2824 | 0.0000 | 0.0055 | 0.0500 | 1 | 33929 |
| q2_stewardship_before_ask | semanticOnly | 246 / 14052 | 0.0081 | 0.0406 | 0.1992 | 0.0000 | 0.0000 | 0.0000 | 0 | 88 |
| q2_stewardship_before_ask | semanticPlusBm25 | 246 / 14052 | 0.0041 | 0.0285 | 0.1220 | 0.0000 | 0.0000 | 0.0000 | 0 | 418 |
| q2_stewardship_before_ask | semanticPlusBm25Jev | 246 / 14052 | 0.1220 | 0.1220 | 0.1220 | 0.4160 | 0.3500 | 0.4500 | 9 | 32781 |
| q3_reunion_reengagement | semanticOnly | 4009 / 14052 | 0.0192 | 0.0858 | 0.3405 | 0.9306 | 0.9188 | 0.9000 | 18 | 57 |
| q3_reunion_reengagement | semanticPlusBm25 | 4009 / 14052 | 0.0197 | 0.0781 | 0.2751 | 0.9306 | 0.8821 | 0.8500 | 17 | 256 |
| q3_reunion_reengagement | semanticPlusBm25Jev | 4009 / 14052 | 0.0130 | 0.0806 | 0.2751 | 0.4800 | 0.4507 | 0.5000 | 10 | 34204 |
| q4_upgrade_ask_review | semanticOnly | 979 / 14052 | 0.0306 | 0.1042 | 0.2850 | 0.1679 | 0.1606 | 0.5000 | 10 | 95 |
| q4_upgrade_ask_review | semanticPlusBm25 | 979 / 14052 | 0.0480 | 0.0919 | 0.2594 | 0.2559 | 0.2370 | 0.8500 | 17 | 467 |
| q4_upgrade_ask_review | semanticPlusBm25Jev | 979 / 14052 | 0.0725 | 0.2370 | 0.2594 | 0.2140 | 0.2764 | 0.9500 | 19 | 33690 |

## Final top-20 action decisions

| Query | Decision model | Scored gold actions | Exact action accuracy | Correct | Permission overrides | Calls | Input tokens | Output tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | jev | 1 / 20 | 0.0000 | 0 | 0 | 17 | 10433 | 953 |
| q1_lapsed_loyal_engaged | llm | 1 / 20 | 0.0000 | 0 | 0 | 20 | 7876 | 345 |
| q2_stewardship_before_ask | jev | 7 / 20 | 1.0000 | 7 | 0 | 13 | 7380 | 741 |
| q2_stewardship_before_ask | llm | 7 / 20 | 1.0000 | 7 | 0 | 20 | 7409 | 363 |
| q3_reunion_reengagement | jev | 10 / 20 | 0.0000 | 0 | 0 | 15 | 8326 | 912 |
| q3_reunion_reengagement | llm | 10 / 20 | 0.0000 | 0 | 0 | 20 | 7029 | 405 |
| q4_upgrade_ask_review | jev | 15 / 20 | 0.1333 | 2 | 0 | 15 | 8779 | 841 |
| q4_upgrade_ask_review | llm | 15 / 20 | 0.0667 | 1 | 0 | 20 | 7469 | 358 |

Embedding: text-embedding-3-small; full vector cache contains 14,056 embeddings; 735279 total input tokens, estimated $0.014706.
Gold metrics are full-population graded retrieval metrics. Exact action accuracy excludes grade-0/exclude and hold-for-review cases because those are not among the four allowed actions.
Q3 grade-2 gold branch is unreachable in the frozen reference implementation; interpret Q3 grade counts accordingly.
Total live runner time: 180695 ms.
