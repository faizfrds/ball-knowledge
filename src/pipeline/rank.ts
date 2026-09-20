import type { CandidateRubricEvaluation } from "./jev-evaluator.js";

export interface RankOptions {
  /** Enable only for a query explicitly asking about future giving. */
  predictiveGivingPrior?: boolean;
  priorByConstituent?: ReadonlyMap<number, number>;
}

export interface RankedCandidate extends CandidateRubricEvaluation {
  rank: number;
  finalRankScore: number | null;
  predictivePrior: number | null;
}

/**
 * Rank from rubric outputs only. Semantic/BM25 already filtered the candidate
 * pool and cannot enter this function or affect its ordering.
 */
export function rankByRubric(
  evaluations: CandidateRubricEvaluation[],
  options: RankOptions = {},
): RankedCandidate[] {
  const candidates: RankedCandidate[] = evaluations.map((result) => {
    const prior = options.predictiveGivingPrior
      ? clamp01(options.priorByConstituent?.get(result.constituentId))
      : null;
    return {
      ...result,
      rank: 0,
      predictivePrior: prior,
      finalRankScore: result.disposition === "eligible" && result.rubricScore !== null
        ? result.rubricScore + (prior === null ? 0 : 0.1 * prior)
        : null,
    };
  });

  candidates.sort((a, b) => {
    const dispositionOrder = dispositionValue(a.disposition) - dispositionValue(b.disposition);
    if (dispositionOrder !== 0) return dispositionOrder;
    // An explicit downrank policy demotes unknown-gate candidates as a separate tier.
    if (a.disposition === "eligible" && b.disposition === "eligible" && a.unknownDownrankCount !== b.unknownDownrankCount) {
      return a.unknownDownrankCount - b.unknownDownrankCount;
    }
    const as = a.finalRankScore ?? Number.NEGATIVE_INFINITY;
    const bs = b.finalRankScore ?? Number.NEGATIVE_INFINITY;
    if (as !== bs) return bs - as;
    if (a.evidenceCompleteness !== b.evidenceCompleteness) return b.evidenceCompleteness - a.evidenceCompleteness;
    return a.constituentId - b.constituentId;
  });
  candidates.forEach((candidate, i) => { candidate.rank = i + 1; });
  return candidates;
}

function dispositionValue(disposition: CandidateRubricEvaluation["disposition"]): number {
  return disposition === "eligible" ? 0 : disposition === "review" ? 1 : 2;
}

function clamp01(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}
