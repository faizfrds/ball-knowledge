import type { LRModel } from "../benchmark/model.js";
import { predictProb } from "../benchmark/model.js";
import type { FeatureVector } from "../benchmark/features.js";

/**
 * Frozen default ranking: development-selected `trained_lr_lr_f`.
 *
 * Protocol (fixed before seeing results; see docs/BENCHMARK.md):
 * - TRAIN cutoff 2023-08-31: fit the six LR candidates (grid in
 *   `src/benchmark/model.ts`, zero-init full-batch GD, deterministic).
 * - DEV cutoff 2024-08-31: select ONE LR hyperparameter set by mean
 *   NDCG@20 (tie-break mean P@20, then declared candidate order).
 *   Winner: `lr_f` (lr=0.5, l2=0.01, epochs=1000).
 * - HELD-OUT cutoff 2025-08-31: report only. NEVER tuned on held-out.
 *
 * The constants below were produced by `npm run freeze-lr` (train-only)
 * on the reference DB and are committed so the worklist orders
 * identically without retraining. To regenerate, run that script — it
 * reads TRAIN + DEV cutoffs only and refuses `--heldout`.
 *
 * Rank-only contract: the sigmoid output is an ORDINAL rank score in
 * (0,1). It is NOT a calibrated probability and NOT expected revenue.
 * API/receipt/UI surfaces must label it "rank only".
 */

export const FROZEN_RANKING_ID = "trained_lr_lr_f";
export const FROZEN_RANKING_VERSION = "benchmark-v1.0.0+train-2023-08-31+dev-2024-08-31";
export const FROZEN_TRAIN_CUTOFF = "2023-08-31";
export const FROZEN_DEV_CUTOFF = "2024-08-31";
export const FROZEN_HYPERPARAMS = { id: "lr_f", lr: 0.5, l2: 0.01, epochs: 1000 } as const;

export const FROZEN_LR_F: LRModel = {
  hyperId: "lr_f",
  means: [
    0.052620089618827984, 0.05422715627668681, 0.06321315625361686,
    0.05552946199829612, 0.006639624252775417, 0.09517077738131474,
  ],
  stds: [
    0.14982713949476784, 0.18309553715780622, 0.18299377084945515,
    0.06952907342930391, 0.07241636963052657, 0.1797121867254813,
  ],
  weights: [
    0.4200671829963724, 0.18546477430785735, 0.3256485148568932,
    0.10267264321598142, -0.058306109817129095, -0.10354722798301592,
  ],
  bias: -3.926692500369802,
};

export interface RankSubscores {
  r: number;
  f: number;
  m: number;
  e: number;
  n: number;
  c: number;
}

/**
 * Ordinal rank score in (0,1) from the six 0–1 priority subscores.
 * Unknown components MUST be passed as 0 (matches the benchmark's
 * treatment: never-gave r=0, no-capacity c=0, no-signal n=0).
 * Rank-only: never present as probability/revenue.
 */
export function frozenLrRankScore(sub: RankSubscores): number {
  const fv = {
    constituentId: 0,
    daysSinceLastPaid: null,
    paidCount5y: 0,
    paidTotal5y: 0,
    maxSinglePaid: null,
    r: sub.r,
    f: sub.f,
    m: sub.m,
    e: sub.e,
    n: sub.n,
    c: sub.c,
    recencyUnknown: false,
    whyNow: "none",
  } as unknown as FeatureVector;
  return predictProb(FROZEN_LR_F, fv);
}
