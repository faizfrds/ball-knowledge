# Full-Corpus Live Fundraising Benchmark

Frozen query set: [complex-benchmark-gold-v1.json](complex-benchmark-gold-v1.json). Cutoff 2025-08-31; eligible population 14,052.
Semantic-only ranks the full population. GPT-5.6 Luna compiles query-specific filters, retrieval phrasings, and scoring criteria. Semantic+BM25 selects at most 2,000 candidates; Jev scores Luna's rubric over scoped raw fields, code ranks the results, and Jev and OpenAI make final action choices for the Jev top 20. No judgment model receives embeddings or retrieval scores.

| Query | Ranker | Relevant / N | Recall@100 | Recall@500 | Recall@2k | NDCG@10 | NDCG@20 | P@20 | Hits@20 | Rank ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | semanticOnly | 3803 / 14052 | 0.0158 | 0.0660 | 0.2374 | 0.1752 | 0.1783 | 0.6000 | 12 | 68 |
| q1_lapsed_loyal_engaged | semanticPlusBm25 | 3803 / 14052 | 0.0108 | 0.0531 | 0.2075 | 0.2922 | 0.2093 | 0.5000 | 10 | 5650 |
| q1_lapsed_loyal_engaged | semanticPlusBm25Jev | 3803 / 14052 | 0.0032 | 0.0484 | 0.2075 | 0.0122 | 0.0127 | 0.1000 | 2 | 73357 |
| q2_stewardship_before_ask | semanticOnly | 246 / 14052 | 0.0081 | 0.0406 | 0.1992 | 0.0000 | 0.0000 | 0.0000 | 0 | 104 |
| q2_stewardship_before_ask | semanticPlusBm25 | 246 / 14052 | 0.0244 | 0.0488 | 0.2317 | 0.0000 | 0.0364 | 0.0500 | 1 | 9426 |
| q2_stewardship_before_ask | semanticPlusBm25Jev | 246 / 14052 | 0.1179 | 0.2317 | 0.2317 | 0.3769 | 0.3163 | 0.3500 | 7 | 43300 |
| q3_reunion_reengagement | semanticOnly | 4009 / 14052 | 0.0192 | 0.0858 | 0.3405 | 0.9306 | 0.9188 | 0.9000 | 18 | 102 |
| q3_reunion_reengagement | semanticPlusBm25 | 4009 / 14052 | 0.0197 | 0.0801 | 0.3208 | 0.8572 | 0.9078 | 0.9000 | 18 | 8856 |
| q3_reunion_reengagement | semanticPlusBm25Jev | 4009 / 14052 | 0.0237 | 0.1040 | 0.3208 | 0.8611 | 0.9104 | 0.9500 | 19 | 94638 |
| q4_upgrade_ask_review | semanticOnly | 979 / 14052 | 0.0306 | 0.1042 | 0.2850 | 0.1679 | 0.1606 | 0.5000 | 10 | 65 |
| q4_upgrade_ask_review | semanticPlusBm25 | 979 / 14052 | 0.0255 | 0.0644 | 0.2370 | 0.1435 | 0.1294 | 0.4000 | 8 | 10278 |
| q4_upgrade_ask_review | semanticPlusBm25Jev | 979 / 14052 | 0.0521 | 0.1379 | 0.2370 | 0.3531 | 0.3430 | 0.8000 | 16 | 95894 |

## Final top-20 action decisions

| Query | Decision model | Scored gold actions | Exact action accuracy | Correct | Permission overrides | Calls | Input tokens | Output tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| q1_lapsed_loyal_engaged | jev | 2 / 20 | 0.0000 | 0 | 0 | 10 | 6146 | 561 |
| q1_lapsed_loyal_engaged | llm | 2 / 20 | 0.0000 | 0 | 0 | 20 | 7846 | 220 |
| q2_stewardship_before_ask | jev | 7 / 20 | 1.0000 | 7 | 0 | 17 | 9315 | 969 |
| q2_stewardship_before_ask | llm | 7 / 20 | 1.0000 | 7 | 0 | 20 | 6837 | 270 |
| q3_reunion_reengagement | jev | 19 / 20 | 0.0000 | 0 | 0 | 15 | 8325 | 915 |
| q3_reunion_reengagement | llm | 19 / 20 | 0.0000 | 0 | 0 | 20 | 7053 | 280 |
| q4_upgrade_ask_review | jev | 6 / 20 | 0.3333 | 2 | 0 | 10 | 6165 | 566 |
| q4_upgrade_ask_review | llm | 6 / 20 | 0.0000 | 0 | 0 | 20 | 7993 | 229 |

Embedding: text-embedding-3-small; full vector cache contains 14,067 embeddings; 735279 total input tokens, estimated $0.014706.
Gold metrics are full-population graded retrieval metrics. Exact action accuracy excludes grade-0/exclude and hold-for-review cases because those are not among the four allowed actions.
Q3 grade-2 gold branch is unreachable in the frozen reference implementation; interpret Q3 grade counts accordingly.
Total live runner time: 374226 ms.
