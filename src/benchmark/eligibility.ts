/**
 * Benchmark eligibility population.
 * Identical eligible set for every ranker at a given as-of cutoff T0.
 * Gates (E1+E2+E3, contact-level; students stay IN — solicitation
 * gating is action-level, not population-level):
 * - entity_type = 'individual' (orgs excluded)
 * - deceased = 0 AND (deceased_date IS NULL OR deceased_date > T0)
 * - do_not_solicit = 0
 * - email_status = 'deliverable' OR phone_status = 'available'
 * No affiliation predicate here, so the 500 affiliation-less individuals
 * are retained (no INNER JOIN on affiliations anywhere in this slice).
 */
import type Database from "better-sqlite3";

export interface EligibleConstituent {
  id: number;
  city: string | null;
  state: string | null;
  deceased_date: string | null;
}

/** Leakage guard: every temporal predicate compares YYYY-MM-DD prefix to T0. */
export function getEligiblePopulation(
  db: Database.Database,
  t0: string,
): EligibleConstituent[] {
  const rows = db
    .prepare(
      `SELECT id, city, state, deceased_date FROM constituents
       WHERE entity_type = 'individual'
         AND deceased = 0
         AND (deceased_date IS NULL OR substr(deceased_date, 1, 10) > ?)
         AND do_not_solicit = 0
         AND (email_status = 'deliverable' OR phone_status = 'available')
       ORDER BY id ASC`,
    )
    .all(t0) as EligibleConstituent[];
  return rows;
}

/** Fail fast if two rankers ever see different populations (order-insensitive). */
export function assertSamePopulation(a: number[], b: number[], label: string): void {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  if (sa.length !== sb.length || sa.some((id, i) => id !== sb[i])) {
    throw new Error(`Population mismatch in ${label}: ${a.length} vs ${b.length}`);
  }
}
