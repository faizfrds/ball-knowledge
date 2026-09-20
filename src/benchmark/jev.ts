/**
 * Hook for Jev-enhanced results to be merged later.
 * The benchmark NEVER calls the Jev API and never modifies the engine.
 * A future run can pass `--jev path/to/jev_scores.csv` with header
 * `constituent_id,score` (one row per eligible constituent; higher = better).
 * This module validates + ranks those external scores on the identical
 * population so Jev-enhanced results join the same leaderboard.
 */
import fs from "node:fs";

export interface JevScores {
  scores: Map<number, number>;
  source: string;
}

export function loadJevScores(csvPath: string, populationIds: number[]): JevScores {
  const raw = fs.readFileSync(csvPath, "utf-8").trim().split(/\r?\n/);
  if (raw.length < 2) throw new Error(`Jev CSV is empty: ${csvPath}`);
  const header = raw[0]!.split(",").map((s) => s.trim());
  if (header[0] !== "constituent_id" || header[1] !== "score") {
    throw new Error(`Jev CSV must have header constituent_id,score; got: ${raw[0]}`);
  }
  const scores = new Map<number, number>();
  for (const line of raw.slice(1)) {
    if (!line.trim()) continue;
    const [idStr, scoreStr] = line.split(",");
    const id = Number(idStr);
    const s = Number(scoreStr);
    if (!Number.isInteger(id) || !Number.isFinite(s)) {
      throw new Error(`Bad Jev row: ${line}`);
    }
    scores.set(id, s);
  }
  const pop = new Set(populationIds);
  const missing = populationIds.filter((id) => !scores.has(id));
  const extra = [...scores.keys()].filter((id) => !pop.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Jev scores must cover exactly the eligible population: missing=${missing.length} extra=${extra.length}`,
    );
  }
  return { scores, source: csvPath };
}

/** Deterministic rank of external scores (score desc, id asc tiebreak). */
export function rankJev(scores: JevScores, populationIds: number[]): number[] {
  return [...populationIds].sort((a, b) => {
    const sa = scores.scores.get(a)!;
    const sb = scores.scores.get(b)!;
    if (sb !== sa) return sb - sa;
    return a - b;
  });
}

export const JEV_RANKER_META = {
  id: "jev_enhanced",
  family: "trained" as const,
  description:
    "External Jev-enhanced scores merged via loadJevScores (same population, same tiebreak). Placeholder until Jev results exist.",
};
