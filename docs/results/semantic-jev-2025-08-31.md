# Semantic vs semantic+Jev @ 2025-08-31 (full population N=14052, donors=601)

> Held-out comparison on the exact same population/outcomes as the benchmark held-out (2025-08-31 -> 2025-11-29). semantic_plus_jev reranks ONLY the semantic top-50 with Jev headline scoring; positions 51..N keep semantic order. Descriptive only: single cutoff, no significance testing, no winner declared.

Query: "Who should I contact before Giving Day, why now, and with what action?" (embedded with text-embedding-3-small). Profiles: concise as-of-safe banded text from pre-T0 giving/interactions/events/career-recorded fields only; no future/opportunity leakage, no PII in output.

Embedding: model text-embedding-3-small, 141 live batches, input tokens 1065726, cost $0.021315 @ $0.02/M input. Cache hits 0, live inputs 14053. Batch latency p50/p95 562/844ms.
Jev rerank (top-50): requested jev-1.13.0, resolved jev-1.13.0. Live calls 48, cache hits 2, errors 0, input tokens 56866, cost $0.002388 @ $0.042/M input (output free). Uncached latency p50/p95 182/409ms.

| ranker | hits@20 | P@20 | NDCG@20 | hits@100 | P@100 | NDCG@100 | paid$ top100 (descr) |
|---|---|---|---|---|---|---|---|
| semantic_cosine | 3 | 0.1500 | 0.1024 | 15 | 0.1500 | 0.1318 | 2403.20 |
| semantic_plus_jev | 2 | 0.1000 | 0.1260 | 15 | 0.1500 | 0.1497 | 2403.20 |

Limits: rerank pool cap 50 (Jev never sees positions 51..N); paid$ descriptive only; scores are ordinal ranks, not probabilities.
