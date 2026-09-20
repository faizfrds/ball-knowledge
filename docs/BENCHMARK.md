# GiveCampus worklist benchmark (v1.0.0)

Independent database-backed ranking benchmark. Compares defensible worklist
rankers on the ingested SQLite reference database with strict as-of leakage
guards. Scores are ordinal ranks, not probabilities; paid-$ is descriptive
only. No calibrated-probability or expected-revenue claims are made.

## Run

```sh
npx tsx src/scripts/benchmark.ts [--db data/givecampus.sqlite]
  [--train 2023-08-31] [--dev 2024-08-31] [--heldout 2025-08-31]
  [--out data/benchmark] [--jev jev_scores.csv]
```

If the DB is missing, the CLI invokes the existing ingest first. Outputs
`data/benchmark/benchmark_<heldout>.json` (machine-readable) and
`data/benchmark/benchmark_<heldout>.md` (leaderboard table).

## Protocol (fixed before seeing results)

- Cutoffs: TRAIN=2023-08-31 (fit only), DEV=2024-08-31 (select only),
  HELD-OUT=2025-08-31 (report only). Outcome window W=(T0, T0+90d].
- Population (identical id set for every ranker at each T0):
  `entity_type='individual' AND deceased=0 AND (deceased_date NULL OR > T0)
  AND do_not_solicit=0 AND (email_status='deliverable' OR phone_status='available')`.
  Students stay in (solicitation gating is action-level). No affiliation join,
  so affiliation-less individuals are retained. N=14,052 at all cutoffs.
- Outcome: paid gifts only (`status='paid'`, `gift_type != 'recurring_parent'`;
  one_time/installment/matching_gift/paid-pledge count as received cash) with
  `gift_date` in W, excluding gifts after `deceased_date`. Pledged/pending/
  failed/refunded never count.
- Selection: ONE priority-index weight set and ONE LR hyperparameter set,
  chosen by mean NDCG@20 on DEV; tie-breaks: mean P@20, then declared
  candidate order (deterministic). Held-out evaluates the selected approach
  plus ALL fixed comparators with no re-selection.
- Ties in any ranking break by constituent id ascending (ids are permuted).

## Leakage guards

- Gifts/interactions/attendance filtered `<= T0`; outcomes strictly `> T0`.
- Career uses `recorded_at <= T0` only (never `started_at`).
- `recurring_parent` headers excluded from features AND outcomes.
- The `opportunities` table, `campaigns.status`, and `funds.active` are never
  read (post-T0 outcomes / current flags).
- Pledge-history capacity flag uses paid pledge rows only (conservative:
  unpaid pledges are intent, not cash).

## Feature subscores (all as-of T0)

- R = 1/(1+days_since_last_paid/180), 0 with `recencyUnknown` when never gave.
- F = min(1, paid_count_5y/5). M = min(1, ln(1+paid_total_5y)/ln(1+50000)).
- E = min(1, (0.5*events_2y + 0.3*connected_interactions_1y + 0.2*distinct_activities)/3).
- N = max applicable {0.9 recent paid gift 30d; 0.8 overdue follow-up with no
  later contact; 0.7 promotion recorded 90d; 0.7 future event <=30d in same
  city/state; 0.6 reunion year (earliest UG B.A./A.B./B.S./B.B.A., 5-yr); 0}.
- C = min(1, 0.7*ln(1+max_single)/ln(1+25000) + 0.2*pledge_flag + 0.1*seniority_hint).

## Algorithm definitions

| id | family | definition |
|---|---|---|
| seeded_random | random | Uniform random, seed 260904 hashed per id (floor baseline) |
| gift_recency_only | recency | Most-recent paid gift first; never-donors last |
| rfm_lexicographic | rfm_lex | Design RFM baseline: sequential sort R asc (nulls last), F desc, M desc |
| rfm_equal | rfm_weighted | (R+F+M)/3 on normalized subscores |
| rfm_r_heavy | rfm_weighted | 0.6R+0.2F+0.2M |
| rfm_f_heavy | rfm_weighted | 0.2R+0.6F+0.2M |
| rfm_m_heavy | rfm_weighted | 0.2R+0.2F+0.6M |
| rfm_fm_only | rfm_weighted | 0.5F+0.5M (no recency) |
| priority_base | priority_index | Proposed 0.25R+0.20F+0.20M+0.15E+0.15N+0.05C |
| priority_recency_heavy | priority_index | 0.45R+0.15F+0.15M+0.10E+0.10N+0.05C (DEV-selected) |
| priority_engagement_heavy | priority_index | 0.15R+0.15F+0.15M+0.30E+0.20N+0.05C |
| priority_whynow_heavy | priority_index | 0.15R+0.15F+0.15M+0.10E+0.40N+0.05C |
| priority_no_capacity | priority_index | 0.25R+0.225F+0.225M+0.15E+0.15N (no capacity proxy) |
| priority_monetary_heavy | priority_index | 0.15R+0.15F+0.40M+0.10E+0.15N+0.05C |
| trained_lr_{a..f} | trained | L2 logistic regression on [r,f,m,e,n,c], fit on TRAIN cutoff+window; grid lr in {0.1,0.5} x l2 in {1.0,0.1,0.01}, epochs {500,500,500,500,1000,1000}; zero-init full-batch GD (no new deps). DEV-selected: lr_f |
| jev_enhanced | external | Hook only: `--jev jev_scores.csv` (`constituent_id,score`, exact population coverage) joins the same leaderboard. No API calls, no engine changes |

## Measured results

DEV cutoff 2024-08-31 -> 2024-11-29 (N=14,052, donors=706):

| ranker | P@20 | NDCG@20 | P@100 | NDCG@100 |
|---|---|---|---|---|
| trained_lr_lr_f | 0.3500 | 0.3210 | 0.3400 | 0.3260 |
| trained_lr_lr_e | 0.3500 | 0.3157 | 0.3500 | 0.3323 |
| rfm_r_heavy | 0.3000 | 0.2442 | 0.3400 | 0.3190 |
| priority_recency_heavy | 0.3000 | 0.2371 | 0.2400 | 0.2270 |
| priority_whynow_heavy | 0.3000 | 0.2240 | 0.1800 | 0.1698 |
| rfm_fm_only | 0.2500 | 0.2017 | 0.2500 | 0.2276 |
| priority_no_capacity | 0.2500 | 0.1971 | 0.2800 | 0.2572 |
| priority_base | 0.2500 | 0.1936 | 0.2600 | 0.2380 |
| priority_engagement_heavy | 0.2500 | 0.1800 | 0.1800 | 0.1647 |
| trained_lr_lr_a/b | 0.2000 | 0.1477 | 0.3100 | 0.2744 |
| rfm_lexicographic | 0.1500 | 0.1199 | 0.2400 | 0.2105 |
| rfm_equal / rfm_f_heavy | 0.1500 | 0.1076 | 0.3300/0.3400 | 0.2902/0.2977 |
| trained_lr_lr_c/d | 0.1500 | 0.1063/0.1052 | 0.3200/0.3300 | 0.2822/0.2876 |
| priority_monetary_heavy | 0.1500 | 0.1039 | 0.2700 | 0.2301 |
| gift_recency_only | 0.1000 | 0.0838 | 0.2400 | 0.2092 |
| rfm_m_heavy | 0.1000 | 0.0762 | 0.2800 | 0.2429 |
| seeded_random | 0.0000 | 0.0000 | 0.0300 | 0.0254 |

HELD-OUT cutoff 2025-08-31 -> 2025-11-29 (N=14,052, donors=601):

| ranker | P@20 | P@100 | NDCG@20 | NDCG@100 | hits@20 | hits@100 | paid$ top100 (descr) |
|---|---|---|---|---|---|---|---|
| trained_lr_lr_e | 0.1500 | 0.1400 | 0.2690 | 0.1851 | 3 | 14 | 28015.00 |
| trained_lr_lr_f (selected) | 0.1500 | 0.1500 | 0.1935 | 0.1665 | 3 | 15 | 29500.00 |
| rfm_m_heavy | 0.1500 | 0.1600 | 0.1383 | 0.1483 | 3 | 16 | 64375.00 |
| trained_lr_lr_d | 0.1500 | 0.1400 | 0.1182 | 0.1323 | 3 | 14 | 28275.00 |
| gift_recency_only | 0.1000 | 0.1300 | 0.1045 | 0.1277 | 2 | 13 | 25958.00 |
| rfm_fm_only | 0.1000 | 0.1400 | 0.1039 | 0.1328 | 2 | 14 | 2800.00 |
| rfm_lexicographic | 0.1000 | 0.1300 | 0.0946 | 0.1240 | 2 | 13 | 25958.00 |
| trained_lr_lr_c | 0.1000 | 0.1500 | 0.0832 | 0.1384 | 2 | 15 | 28300.00 |
| rfm_r_heavy | 0.1000 | 0.1600 | 0.0775 | 0.1397 | 2 | 16 | 27315.00 |
| priority_no_capacity | 0.1000 | 0.2000 | 0.0663 | 0.1685 | 2 | 20 | 33725.00 |
| rfm_equal | 0.0500 | 0.1900 | 0.0448 | 0.1685 | 1 | 19 | 28715.00 |
| rfm_f_heavy | 0.0500 | 0.2100 | 0.0448 | 0.1854 | 1 | 21 | 29315.00 |
| priority_engagement_heavy | 0.0500 | 0.1500 | 0.0348 | 0.1265 | 1 | 15 | 10028.20 |
| priority_base | 0.0500 | 0.1800 | 0.0323 | 0.1511 | 1 | 18 | 33575.00 |
| priority_monetary_heavy | 0.0500 | 0.1400 | 0.0323 | 0.1172 | 1 | 14 | 9850.00 |
| priority_recency_heavy (selected) | 0.0000 | 0.1600 | 0.0000 | 0.1338 | 0 | 16 | 27529.80 |
| priority_whynow_heavy | 0.0000 | 0.1500 | 0.0000 | 0.1254 | 0 | 15 | 8679.80 |
| seeded_random | 0.0000 | 0.0400 | 0.0000 | 0.0344 | 0 | 4 | 25565.00 |
| trained_lr_lr_a/b | 0.0000 | 0.1700 | 0.0000 | 0.1443 | 0 | 17 | 33450.00 |

Reading notes (descriptive, not claims): every ranker beats random at P@100;
top-20 hits are small-sample (0-3 of 20), so DEV-to-held-out rank shuffling at
@20 is expected noise, not a finding. The DEV-selected recency-heavy index
scored 0 hits@20 held-out while its no-capacity sibling led priority variants
at P@100 (0.20) — selection on a single DEV @20 snapshot overfits; a future
round should select on mean rank across two DEV cutoffs. The trained LR family
generalized best at NDCG@20 (lr_e 0.269 held-out vs 0.316 dev). paid$ top100 is
reported for context only and is whale-dominated (e.g. rfm_m_heavy).

## Jev hook

`src/benchmark/jev.ts` (`loadJevScores`, `rankJev`) validates exact population
coverage and ranks external scores with the same tiebreak. The CLI merges them
as `jev_enhanced` when `--jev` is passed. No network calls; engine untouched.

## Files

- `src/benchmark/eligibility.ts`, `features.ts`, `algorithms.ts`, `model.ts`,
  `metrics.ts`, `run.ts`, `jev.ts`
- `src/scripts/benchmark.ts`
- `tests/benchmark.test.ts`
- Full JSON: `data/benchmark/benchmark_2025-08-31.json` (generated, gitignored)
