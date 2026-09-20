# Jev characteristic precompute @ 2026-08-31

Pool: 14052 constituents (buildLivePool cap 14052); bank: 7 yes/no characteristics; chunk size 7.

Mode: live Jev. Live calls 14052, cache hits 0, errors 9977, fallback used false.
Tokens: input 4434059, output 680525; est. cost $0.186230 @ $0.042/M input (output free).
Latency (uncached, ms): p50 196, p95 305 (n=4075).

Sampled 100 simulated requests (one row per characteristic):

r001_gave_within_90d, r002_gifts_24mo_at_least_5, r003_lifetime_at_least_1000, r004_lapsed_over_730d, r005_any_engagement_events, r006_eligible_for_solicitation, r007_connected_within_365d, ... (7 total; ids r001..r007)

Highest yes-rate characteristics:

| characteristic | yes | no | uncertain/unknown |
|---|---|---|---|
| r | eligible_for_solicitation | 4075 | 0 | 9977 |
| r | any_engagement_events | 962 | 3113 | 9977 |
| r | lifetime_at_least_1000 | 438 | 3637 | 9977 |
| r | connected_within_365d | 266 | 3668 | 10118 |
| r | gave_within_90d | 67 | 3942 | 10043 |
| r | lapsed_over_730d | 35 | 3975 | 10042 |
| r | gifts_24mo_at_least_5 | 19 | 4056 | 9977 |

Lowest yes-rate characteristics:

| characteristic | yes | no | uncertain/unknown |
|---|---|---|---|
| r | gifts_24mo_at_least_5 | 19 | 4056 | 9977 |
| r | lapsed_over_730d | 35 | 3975 | 10042 |
| r | gave_within_90d | 67 | 3942 | 10043 |
| r | connected_within_365d | 266 | 3668 | 10118 |
| r | lifetime_at_least_1000 | 438 | 3637 | 9977 |
| r | any_engagement_events | 962 | 3113 | 9977 |
| r | eligible_for_solicitation | 4075 | 0 | 9977 |

Verdicts: yes/no from Jev noul (>=0.7 / <=0.3); uncertain otherwise or when an answer is missing. This precomputed answer materialization is a cold-start cache for later pipeline steps, not a benchmark result.