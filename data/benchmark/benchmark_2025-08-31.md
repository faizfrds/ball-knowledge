# GiveCampus worklist benchmark v1.0.0

Dataset v1.2; train=2023-08-31 dev=2024-08-31 held-out=2025-08-31; window=90d.
Population: entity_type='individual' AND deceased=0 AND (deceased_date NULL or > T0) AND do_not_solicit=0 AND (email deliverable OR phone available); identical id set for every ranker
Outcome: paid gifts (status='paid', gift_type != 'recurring_parent') with gift_date in (T0, T0+90d], excluding gifts after deceased_date
Selection: priority_index_weight_set -> priority_recency_heavy (mean NDCG@20 over dev cutoffs; tie-break mean P@20, then declared candidate order) | trained_lr_hyperparams -> trained_lr_lr_f (mean NDCG@20 over dev cutoffs; tie-break mean P@20, then declared candidate order)

## Held-out leaderboard @ 2025-08-31 -> 2025-11-29 (N=14052, donors=601)

| ranker | family | P@20 | P@100 | NDCG@20 | NDCG@100 | hits@20 | hits@100 | paid$ top100 (descr) | ms |
|---|---|---|---|---|---|---|---|---|---|
| trained_lr_lr_e | trained | 0.1500 | 0.1400 | 0.2690 | 0.1851 | 3 | 14 | 28015.00 | 13 |
| trained_lr_lr_f | trained | 0.1500 | 0.1500 | 0.1935 | 0.1665 | 3 | 15 | 29500.00 | 11 |
| rfm_m_heavy | rfm_weighted | 0.1500 | 0.1600 | 0.1383 | 0.1483 | 3 | 16 | 64375.00 | 8 |
| trained_lr_lr_d | trained | 0.1500 | 0.1400 | 0.1182 | 0.1323 | 3 | 14 | 28275.00 | 10 |
| gift_recency_only | recency | 0.1000 | 0.1300 | 0.1045 | 0.1277 | 2 | 13 | 25958.00 | 8 |
| rfm_fm_only | rfm_weighted | 0.1000 | 0.1400 | 0.1039 | 0.1328 | 2 | 14 | 2800.00 | 6 |
| rfm_lexicographic | rfm_lex | 0.1000 | 0.1300 | 0.0946 | 0.1240 | 2 | 13 | 25958.00 | 15 |
| trained_lr_lr_c | trained | 0.1000 | 0.1500 | 0.0832 | 0.1384 | 2 | 15 | 28300.00 | 9 |
| rfm_r_heavy | rfm_weighted | 0.1000 | 0.1600 | 0.0775 | 0.1397 | 2 | 16 | 27315.00 | 8 |
| priority_no_capacity | priority_index | 0.1000 | 0.2000 | 0.0663 | 0.1685 | 2 | 20 | 33725.00 | 9 |
| rfm_equal | rfm_weighted | 0.0500 | 0.1900 | 0.0448 | 0.1685 | 1 | 19 | 28715.00 | 9 |
| rfm_f_heavy | rfm_weighted | 0.0500 | 0.2100 | 0.0448 | 0.1854 | 1 | 21 | 29315.00 | 9 |
| priority_engagement_heavy | priority_index | 0.0500 | 0.1500 | 0.0348 | 0.1265 | 1 | 15 | 10028.20 | 10 |
| priority_base | priority_index | 0.0500 | 0.1800 | 0.0323 | 0.1511 | 1 | 18 | 33575.00 | 9 |
| priority_monetary_heavy | priority_index | 0.0500 | 0.1400 | 0.0323 | 0.1172 | 1 | 14 | 9850.00 | 9 |
| priority_recency_heavy | priority_index | 0.0000 | 0.1600 | 0.0000 | 0.1338 | 0 | 16 | 27529.80 | 9 |
| priority_whynow_heavy | priority_index | 0.0000 | 0.1500 | 0.0000 | 0.1254 | 0 | 15 | 8679.80 | 9 |
| seeded_random | random | 0.0000 | 0.0400 | 0.0000 | 0.0344 | 0 | 4 | 25565.00 | 15 |
| trained_lr_lr_a | trained | 0.0000 | 0.1700 | 0.0000 | 0.1443 | 0 | 17 | 33450.00 | 12 |
| trained_lr_lr_b | trained | 0.0000 | 0.1700 | 0.0000 | 0.1443 | 0 | 17 | 33450.00 | 10 |

Selected approach: priority_index=priority_recency_heavy, trained=trained_lr_lr_f.
paid$ is descriptive only, never a ranking objective. Scores are ordinal ranks, not probabilities.
Jev-enhanced results not yet merged; pass --jev jev_scores.csv to join the same leaderboard.
