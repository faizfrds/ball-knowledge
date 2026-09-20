import type { RankedDocument, RetrievalId } from "./bm25.js";

export interface FusedDocument {
  id: RetrievalId;
  /** Internal candidate-selection score. Do not pass it to rubric evaluators. */
  score: number;
}

function compareIds(a: RetrievalId, b: RetrievalId): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en");
}

/** Reciprocal-rank fusion over 1-based ranks; scores are only for pool selection. */
export function reciprocalRankFusion(
  rankedLists: readonly (readonly (RetrievalId | RankedDocument)[])[],
  k = 60,
): FusedDocument[] {
  if (!Number.isFinite(k) || k <= 0) throw new Error("RRF k must be a positive finite number");
  const scores = new Map<RetrievalId, number>();
  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const id = typeof item === "object" ? item.id : item;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
}
