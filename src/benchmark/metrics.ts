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
