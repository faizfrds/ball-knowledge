/**
 * Ranking metrics. Relevance is binary: 1 if the constituent made >=1 paid
 * non-recurring-parent gift in the outcome window, else 0.
 * Total future paid $ is reported as descriptive context only (never a
 * ranking objective — it is dominated by a few large gifts).
 */

export interface CutMetrics {
  k: number;
  precision: number;
  ndcg: number;
  hits: number;
  amount: number;
}

export interface AlgorithmMetrics {
  precisionAt20: number;
  precisionAt100: number;
  ndcgAt20: number;
  ndcgAt100: number;
  hitsAt20: number;
  hitsAt100: number;
  /** Descriptive only: total paid $ in window from ranked top-100. */
  amountTop100: number;
  /** Descriptive only: total paid $ in window from whole population. */
  amountPopulation: number;
  donorCount: number;
  populationN: number;
}

export interface PrecisionRecallMetrics { precision: number; recall: number; hits: number }
export interface ClassificationMetrics { accuracy: number; macroF1: number; perClassF1: Record<string, number> }
export interface PairedInterval {
  estimate: number; lower: number; upper: number; confidenceLevel: number; n: number; method: string;
}

function dcg(relevances: number[]): number {
  let s = 0;
  for (let i = 0; i < relevances.length; i++) {
    if (relevances[i]! > 0) s += 1 / Math.log2(i + 2);
  }
  return s;
}

/** Binary-relevance NDCG@k for a ranked id list. */
export function ndcgAtK(rankedIds: number[], donors: Set<number>, k: number): number {
  const top = rankedIds.slice(0, k);
  const actual = dcg(top.map((id) => (donors.has(id) ? 1 : 0)));
  const totalHits = donors.size;
  const idealLen = Math.min(k, totalHits);
  if (idealLen === 0) return 0;
  const ideal = dcg(new Array<number>(idealLen).fill(1));
  return ideal === 0 ? 0 : actual / ideal;
}

export function precisionAtK(
  rankedIds: number[],
  donors: Set<number>,
  k: number,
): { p: number; hits: number } {
  const top = rankedIds.slice(0, k);
  const hits = top.filter((id) => donors.has(id)).length;
  return { p: top.length === 0 ? 0 : hits / top.length, hits };
}

/** Graded NDCG uses gain 2^relevance - 1 and log2 position discounts. */
export function gradedNdcgAtK(rankedIds: number[], relevance: ReadonlyMap<number, number>, k: number): number {
  if (!Number.isInteger(k) || k < 0) throw new RangeError("k must be a non-negative integer");
  const values = [...relevance.values()];
  if (values.some((v) => !Number.isFinite(v) || v < 0)) throw new RangeError("relevance must be finite and non-negative");
  const dcg = (rels: number[]) => rels.reduce((s, rel, i) => s + (2 ** rel - 1) / Math.log2(i + 2), 0);
  const actual = dcg(rankedIds.slice(0, k).map((id) => relevance.get(id) ?? 0));
  const ideal = dcg(values.sort((a, b) => b - a).slice(0, k));
  return ideal === 0 ? 0 : actual / ideal;
}
export const gradedNdcgAt10 = (ids: number[], rel: ReadonlyMap<number, number>) => gradedNdcgAtK(ids, rel, 10);
export const gradedNdcgAt20 = (ids: number[], rel: ReadonlyMap<number, number>) => gradedNdcgAtK(ids, rel, 20);

export function precisionRecallAtK(ids: number[], relevant: ReadonlySet<number>, k: number): PrecisionRecallMetrics {
  const { p, hits } = precisionAtK(ids, new Set(relevant), k);
  return { precision: p, recall: relevant.size === 0 ? 0 : hits / relevant.size, hits };
}
export function reciprocalRank(ids: number[], relevant: ReadonlySet<number>): number {
  const i = ids.findIndex((id) => relevant.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}
export function meanReciprocalRank(queries: number[][], relevant: ReadonlySet<number>[]): number {
  assertSameLength(queries, relevant, "queries", "relevant");
  return queries.length === 0 ? 0 : queries.reduce((s, ids, i) => s + reciprocalRank(ids, relevant[i]!), 0) / queries.length;
}

export function multiclassMetrics(actual: readonly string[], predicted: readonly string[], labels?: readonly string[]): ClassificationMetrics {
  assertSameLength(actual, predicted, "actual", "predicted");
  const classes = [...new Set(labels ?? [...actual, ...predicted])].sort();
  const perClassF1: Record<string, number> = {};
  for (const label of classes) {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] === label && predicted[i] === label) tp++;
      else if (actual[i] !== label && predicted[i] === label) fp++;
      else if (actual[i] === label && predicted[i] !== label) fn++;
    }
    const denom = 2 * tp + fp + fn;
    perClassF1[label] = denom === 0 ? 0 : 2 * tp / denom;
  }
  const accuracy = actual.length === 0 ? 0 : actual.filter((v, i) => v === predicted[i]).length / actual.length;
  return { accuracy, macroF1: classes.length ? Object.values(perClassF1).reduce((a, b) => a + b, 0) / classes.length : 0, perClassF1 };
}

function assertSameLength(a: readonly unknown[], b: readonly unknown[], aName: string, bName: string): void {
  if (a.length !== b.length) throw new RangeError(`${aName} and ${bName} must have the same length`);
}

export function evaluateRanking(
  rankedIds: number[],
  donors: Set<number>,
  amounts: Map<number, number>,
): AlgorithmMetrics {
  const p20 = precisionAtK(rankedIds, donors, 20);
  const p100 = precisionAtK(rankedIds, donors, 100);
  let amountTop100 = 0;
  for (const id of rankedIds.slice(0, 100)) amountTop100 += amounts.get(id) ?? 0;
  let amountPopulation = 0;
  for (const v of amounts.values()) amountPopulation += v;
  return {
    precisionAt20: round4(p20.p),
    precisionAt100: round4(p100.p),
    ndcgAt20: round4(ndcgAtK(rankedIds, donors, 20)),
    ndcgAt100: round4(ndcgAtK(rankedIds, donors, 100)),
    hitsAt20: p20.hits,
    hitsAt100: p100.hits,
    amountTop100: round2(amountTop100),
    amountPopulation: round2(amountPopulation),
    donorCount: donors.size,
    populationN: rankedIds.length,
  };
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
