# Full-Corpus Live Fundraising Benchmark

Frozen query set: [complex-benchmark-gold-v1.json](complex-benchmark-gold-v1.json). Cutoff 2025-08-31; eligible population 14,052.
Semantic-only and semantic+BM25 rankings cover the full population. Jev and OpenAI each make a final action choice for the exact same hybrid top 20 per query; only as-of-safe raw field values are sent, never embeddings or retrieval scores.

| Query | Ranker | Relevant / N | Recall@100 | Recall@500 | Recall@2k | NDCG@10 | NDCG@20 | P@20 | Hits@20 | Retrieval ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | semanticOnly | 3803 / 14052 | 0.0158 | 0.0660 | 0.2374 | 0.1752 | 0.1783 | 0.6000 | 12 | 74 |
| q1_lapsed_loyal_engaged | semanticPlusBm25 | 3803 / 14052 | 0.0155 | 0.0786 | 0.2824 | 0.0464 | 0.1042 | 0.4500 | 9 | 332 |
| q2_stewardship_before_ask | semanticOnly | 246 / 14052 | 0.0081 | 0.0406 | 0.1992 | 0.0000 | 0.0000 | 0.0000 | 0 | 70 |
| q2_stewardship_before_ask | semanticPlusBm25 | 246 / 14052 | 0.0041 | 0.0285 | 0.1220 | 0.0000 | 0.0000 | 0.0000 | 0 | 269 |
| q3_reunion_reengagement | semanticOnly | 4009 / 14052 | 0.0192 | 0.0858 | 0.3405 | 0.9306 | 0.9188 | 0.9000 | 18 | 59 |
| q3_reunion_reengagement | semanticPlusBm25 | 4009 / 14052 | 0.0197 | 0.0781 | 0.2751 | 0.9306 | 0.8821 | 0.8500 | 17 | 257 |
| q4_upgrade_ask_review | semanticOnly | 979 / 14052 | 0.0306 | 0.1042 | 0.2850 | 0.1679 | 0.1606 | 0.5000 | 10 | 58 |
| q4_upgrade_ask_review | semanticPlusBm25 | 979 / 14052 | 0.0480 | 0.0919 | 0.2594 | 0.2559 | 0.2370 | 0.8500 | 17 | 258 |

## Final top-20 action decisions

| Query | Decision model | Scored gold actions | Exact action accuracy | Correct | Permission overrides | Calls | Input tokens | Output tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | jev | 9 / 20 | 0.8889 | 8 | 0 | 0 | 0 | 0 |
| q1_lapsed_loyal_engaged | llm | 9 / 20 | 0.2222 | 2 | 0 | 20 | 7607 | 370 |
| q2_stewardship_before_ask | jev | 0 / 20 | 0.0000 | 0 | 0 | 0 | 0 | 0 |
| q2_stewardship_before_ask | llm | 0 / 20 | 0.0000 | 0 | 0 | 20 | 7454 | 376 |
| q3_reunion_reengagement | jev | 17 / 20 | 0.0000 | 0 | 0 | 0 | 0 | 0 |
| q3_reunion_reengagement | llm | 17 / 20 | 0.0000 | 0 | 0 | 20 | 7019 | 409 |
| q4_upgrade_ask_review | jev | 11 / 20 | 0.3636 | 4 | 0 | 0 | 0 | 0 |
| q4_upgrade_ask_review | llm | 11 / 20 | 0.0000 | 0 | 0 | 20 | 7376 | 377 |

Embedding: text-embedding-3-small; full vector cache contains 14,056 embeddings; 735279 total input tokens, estimated $0.014706.
Gold metrics are full-population graded retrieval metrics. Exact action accuracy excludes grade-0/exclude and hold-for-review cases because those are not among the four allowed actions.
Q3 grade-2 gold branch is unreachable in the frozen reference implementation; interpret Q3 grade counts accordingly.
Total live runner time: 27174 ms.
