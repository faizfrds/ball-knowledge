# Jev characteristic precompute @ 2026-08-31

Pool: 14052 constituents (buildLivePool cap 14052); bank: 7 yes/no characteristics; chunk size 7.

Mode: live Jev. Live calls 9977, cache hits 4075, errors 0, fallback used false.
Tokens: input 10855139, output 1666159; est. cost $0.455916 @ $0.042/M input (output free).
Latency (uncached, ms): p50 197, p95 328 (n=9977).

Sampled 100 simulated requests (one row per characteristic):

r001_gave_within_90d, r002_gifts_24mo_at_least_5, r003_lifetime_at_least_1000, r004_lapsed_over_730d, r005_any_engagement_events, r006_eligible_for_solicitation, r007_connected_within_365d, ... (7 total; ids r001..r007)

Highest yes-rate characteristics:

| characteristic | yes | no | uncertain/unknown |
|---|---|---|---|
| r | eligible_for_solicitation | 14052 | 0 | 0 |
| r | any_engagement_events | 3457 | 10595 | 0 |
| r | lifetime_at_least_1000 | 1564 | 12488 | 0 |
| r | connected_within_365d | 1013 | 12519 | 520 |
| r | gave_within_90d | 241 | 13598 | 213 |
| r | lapsed_over_730d | 194 | 13656 | 202 |
| r | gifts_24mo_at_least_5 | 54 | 13998 | 0 |

Lowest yes-rate characteristics:

| characteristic | yes | no | uncertain/unknown |
|---|---|---|---|
| r | gifts_24mo_at_least_5 | 54 | 13998 | 0 |
| r | lapsed_over_730d | 194 | 13656 | 202 |
| r | gave_within_90d | 241 | 13598 | 213 |
| r | connected_within_365d | 1013 | 12519 | 520 |
| r | lifetime_at_least_1000 | 1564 | 12488 | 0 |
| r | any_engagement_events | 3457 | 10595 | 0 |
| r | eligible_for_solicitation | 14052 | 0 | 0 |

Verdicts: yes/no from Jev noul (>=0.7 / <=0.3); uncertain otherwise or when an answer is missing. This precomputed answer materialization is a cold-start cache for later pipeline steps, not a benchmark result.