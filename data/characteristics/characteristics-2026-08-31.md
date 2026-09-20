# Jev characteristic precompute @ 2026-08-31

Pool: 20 constituents (buildLivePool cap 20); bank: 100 yes/no characteristics; chunk size 50.

Mode: live Jev. Live calls 40, cache hits 0, errors 0, fallback used false.
Tokens: input 189168, output 46060; est. cost $0.007945 @ $0.042/M input (output free).
Latency (uncached, ms): p50 224, p95 777 (n=40).

Sampled 100 simulated requests (one row per characteristic):

r001_gave_within_7d, r002_gave_within_14d, r003_gave_within_30d, r004_gave_within_60d, r005_gave_within_90d, r006_gave_within_120d, r007_gave_within_180d, r008_gave_within_270d, r009_gave_within_365d, r010_gave_within_545d, ... (100 total; ids r001..r100)

Highest yes-rate characteristics:

| characteristic | yes | no | uncertain/unknown |
|---|---|---|---|
| r | eligible_for_solicitation | 20 | 0 | 0 |
| r | gave_within_1095d | 20 | 0 | 0 |
| r | gave_within_1460d | 20 | 0 | 0 |
| r | gave_within_180d | 19 | 0 | 1 |
| r | gave_within_1825d | 20 | 0 | 0 |
| r | gave_within_2555d | 20 | 0 | 0 |
| r | gave_within_270d | 20 | 0 | 0 |
| r | gave_within_365d | 20 | 0 | 0 |
| r | gave_within_545d | 20 | 0 | 0 |
| r | gave_within_730d | 20 | 0 | 0 |
| r | gifts_24mo_at_least_1 | 20 | 0 | 0 |
| r | last_gift_this_calendar_year | 20 | 0 | 0 |
| r | lifetime_at_least_100 | 20 | 0 | 0 |
| r | lifetime_at_least_250 | 20 | 0 | 0 |
| r | gave_within_120d | 19 | 1 | 0 |

Lowest yes-rate characteristics:

| characteristic | yes | no | uncertain/unknown |
|---|---|---|---|
| r | volunteer_or_leadership_role | 0 | 20 | 0 |
| r | title_has_vice | 0 | 20 | 0 |
| r | title_has_svp | 0 | 20 | 0 |
| r | title_has_principal | 0 | 20 | 0 |
| r | title_has_president | 0 | 20 | 0 |
| r | title_has_partner | 0 | 20 | 0 |
| r | title_has_owner | 0 | 20 | 0 |
| r | title_has_officer | 0 | 20 | 0 |
| r | title_has_head | 0 | 20 | 0 |
| r | title_has_founder | 0 | 20 | 0 |
| r | title_has_executive | 0 | 20 | 0 |
| r | title_has_evp | 0 | 20 | 0 |
| r | title_has_director | 0 | 20 | 0 |
| r | title_has_chief | 0 | 20 | 0 |
| r | title_has_board | 0 | 20 | 0 |

Verdicts: yes/no from Jev noul (>=0.7 / <=0.3); uncertain otherwise or when an answer is missing. This precomputed answer materialization is a cold-start cache for later pipeline steps, not a benchmark result.