/**
 * Benchmark ranker family. Every ranker scores the SAME eligible population
 * from the SAME as-of feature vectors; final order breaks ties by
 * constituent id ascending (ids are permuted, no demographic meaning —
 * tiebreak only). Seeded-random uses a fixed seed (dataset seed 260904)
 * hashed per id, so it is deterministic across runs.
 */
import type { FeatureVector } from "./features.js";

export interface Ranker {
  id: string;
  family: "random" | "recency" | "rfm_lex" | "rfm_weighted" | "priority_index" | "trained";
  description: string;
  /** Higher = rank first. Must be deterministic. */
  score: (fv: FeatureVector) => number;
}

/** Mulberry32 — deterministic PRNG for the random baseline. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RANDOM_SEED = 260904;

function seededScore(id: number): number {
  // Hash id with seed so score is order-independent and reproducible.
  let h = (id * 0x9e3779b1) ^ RANDOM_SEED;
  const rand = mulberry32(h >>> 0);
  return rand();
}

export interface WeightSet {
  id: string;
  description: string;
  weights: { r: number; f: number; m: number; e: number; n: number; c: number };
}

export const RFM_WEIGHT_SETS: WeightSet[] = [
  { id: "rfm_equal", description: "RFM equal weights (1/3 each)", weights: { r: 1 / 3, f: 1 / 3, m: 1 / 3, e: 0, n: 0, c: 0 } },
  { id: "rfm_r_heavy", description: "RFM recency-heavy (0.6/0.2/0.2)", weights: { r: 0.6, f: 0.2, m: 0.2, e: 0, n: 0, c: 0 } },
  { id: "rfm_f_heavy", description: "RFM frequency-heavy (0.2/0.6/0.2)", weights: { r: 0.2, f: 0.6, m: 0.2, e: 0, n: 0, c: 0 } },
  { id: "rfm_m_heavy", description: "RFM monetary-heavy (0.2/0.2/0.6)", weights: { r: 0.2, f: 0.2, m: 0.6, e: 0, n: 0, c: 0 } },
  { id: "rfm_fm_only", description: "RFM no-recency (0/0.5/0.5): frequency+monetary only", weights: { r: 0, f: 0.5, m: 0.5, e: 0, n: 0, c: 0 } },
];

/** Proposed engineered priority-index family (weights sum to 1.0). */
export const PRIORITY_WEIGHT_SETS: WeightSet[] = [
  { id: "priority_base", description: "Proposed base 0.25R+0.20F+0.20M+0.15E+0.15N+0.05C", weights: { r: 0.25, f: 0.2, m: 0.2, e: 0.15, n: 0.15, c: 0.05 } },
  { id: "priority_recency_heavy", description: "Recency-heavy 0.45R+0.15F+0.15M+0.10E+0.10N+0.05C", weights: { r: 0.45, f: 0.15, m: 0.15, e: 0.1, n: 0.1, c: 0.05 } },
  { id: "priority_engagement_heavy", description: "Engagement-heavy 0.15R+0.15F+0.15M+0.30E+0.20N+0.05C", weights: { r: 0.15, f: 0.15, m: 0.15, e: 0.3, n: 0.2, c: 0.05 } },
  { id: "priority_whynow_heavy", description: "Why-now-heavy 0.15R+0.15F+0.15M+0.10E+0.40N+0.05C", weights: { r: 0.15, f: 0.15, m: 0.15, e: 0.1, n: 0.4, c: 0.05 } },
  { id: "priority_no_capacity", description: "No capacity proxy (0.25R+0.225F+0.225M+0.15E+0.15N+0C)", weights: { r: 0.25, f: 0.225, m: 0.225, e: 0.15, n: 0.15, c: 0 } },
  { id: "priority_monetary_heavy", description: "Monetary-heavy 0.15R+0.15F+0.40M+0.10E+0.15N+0.05C", weights: { r: 0.15, f: 0.15, m: 0.4, e: 0.1, n: 0.15, c: 0.05 } },
];

function weightedScore(w: WeightSet["weights"]): (fv: FeatureVector) => number {
  return (fv) => w.r * fv.r + w.f * fv.f + w.m * fv.m + w.e * fv.e + w.n * fv.n + w.c * fv.c;
}

export function buildFixedRankers(): Ranker[] {
  const rankers: Ranker[] = [
    {
      id: "seeded_random",
      family: "random",
      description: `Seeded uniform random (seed ${RANDOM_SEED}); order-independent floor baseline`,
      score: (fv) => seededScore(fv.constituentId),
    },
    {
      id: "gift_recency_only",
      family: "recency",
      description: "Most-recent paid gift first; never-donors last (id tiebreak)",
      score: (fv) => (fv.daysSinceLastPaid === null ? -1e9 : -fv.daysSinceLastPaid),
    },
    {
      id: "rfm_lexicographic",
      family: "rfm_lex",
      description: "Design RFM baseline: sequential sort R asc, F desc, M desc (lexicographic, not scored)",
      score: () => 0, // handled by lexicographicRank below
    },
    ...RFM_WEIGHT_SETS.map((w) => ({
      id: w.id,
      family: "rfm_weighted" as const,
      description: `Weighted RFM on normalized subscores: ${w.description}`,
      score: weightedScore(w.weights),
    })),
    ...PRIORITY_WEIGHT_SETS.map((w) => ({
      id: w.id,
      family: "priority_index" as const,
      description: `Engineered priority index: ${w.description}`,
      score: weightedScore(w.weights),
    })),
  ];
  return rankers;
}

/**
 * Rank a population. Lexicographic RFM sorts sequentially
 * (R asc with nulls last, F desc, M desc); all others sort by
 * score desc. Ties ALWAYS break by constituent id ascending.
 */
export function rank(
  ranker: Ranker,
  features: Map<number, FeatureVector>,
  populationIds: number[],
): number[] {
  const ids = [...populationIds];
  if (ranker.id === "rfm_lexicographic") {
    ids.sort((a, b) => {
      const fa = features.get(a)!;
      const fb = features.get(b)!;
      const ra = fa.daysSinceLastPaid === null ? Number.POSITIVE_INFINITY : fa.daysSinceLastPaid;
      const rb = fb.daysSinceLastPaid === null ? Number.POSITIVE_INFINITY : fb.daysSinceLastPaid;
      if (ra !== rb) return ra - rb;
      if (fb.paidCount5y !== fa.paidCount5y) return fb.paidCount5y - fa.paidCount5y;
      if (fb.paidTotal5y !== fa.paidTotal5y) return fb.paidTotal5y - fa.paidTotal5y;
      return a - b;
    });
    return ids;
  }
  const scored = ids.map((id) => ({ id, s: ranker.score(features.get(id)!) }));
  scored.sort((x, y) => (y.s !== x.s ? y.s - x.s : x.id - y.id));
  return scored.map((r) => r.id);
}
