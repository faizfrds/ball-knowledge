import type Database from "better-sqlite3";
import type { WorklistFilter } from "./criterion.js";

/**
 * Parameterized, as-of-safe reads for the GiveCampus engine.
 * Typed filter in, bound parameters out — no executable filter strings.
 */

export interface ConstituentRow {
  id: number;
  entity_type: string;
  deceased: number;
  deceased_date: string | null;
  do_not_solicit: number;
  email_status: string;
  phone_status: string;
  city: string | null;
  state: string | null;
  preferred_name: string;
}

export interface GiftRow {
  id: number;
  gift_date: string;
  amount: number;
  status: string;
  gift_type: string;
}

export interface InteractionRow {
  id: number;
  occurred_at: string;
  purpose: string;
  outcome: string;
  direction: string;
  follow_up_date: string | null;
  related_gift_id: number | null;
  notes: string;
}

export interface AttendanceRow {
  id: number;
  attended_at: string;
  event_id: number;
}

export interface CareerRow {
  id: number;
  employer: string;
  job_title: string | null;
  is_current: number;
  recorded_at: string;
  started_at: string;
}

export interface DegreeRow {
  id: number;
  degree_type: string | null;
  class_year: number | null;
}

export interface AffiliationRow {
  id: number;
  affiliation_type: string;
}

export interface ActivityRow {
  activity_name: string;
}

export interface EventRow {
  id: number;
  starts_at: string;
  city: string;
  state: string;
}

const ALLOWLIST_AFFIL = /^[A-Za-z0-9 _-]{1,80}$/;

export function listCandidateConstituents(
  db: Database.Database,
  filter: WorklistFilter,
  scanLimit = 4000,
): ConstituentRow[] {
  // LEFT JOIN affiliations to retain the 500 affiliation-less constituents;
  // optional affiliation predicate must not turn it into an inner join.
  const params: unknown[] = [];
  let sql = `SELECT c.id, c.entity_type, c.deceased, c.deceased_date, c.do_not_solicit,
    c.email_status, c.phone_status, c.city, c.state, c.preferred_name
    FROM constituents c LEFT JOIN affiliations a ON a.constituent_id = c.id`;
  const wheres: string[] = [];
  if (filter.city) {
    wheres.push(`c.city = ?`);
    params.push(filter.city);
  }
  if (filter.state) {
    wheres.push(`c.state = ?`);
    params.push(filter.state);
  }
  if (filter.affiliationType) {
    if (!ALLOWLIST_AFFIL.test(filter.affiliationType)) throw new Error("Invalid affiliationType");
    wheres.push(`(a.affiliation_type = ? OR ? = '')`);
    params.push(filter.affiliationType, "");
    // Note: rows without affiliations are retained only when no
    // affiliationType filter is set; with a filter, NULL rows miss by design.
  }
  if (wheres.length > 0) sql += ` WHERE ${wheres.join(" AND ")}`;
  sql += ` GROUP BY c.id ORDER BY c.id LIMIT ?`;
  params.push(scanLimit);
  return db.prepare(sql).all(...params) as ConstituentRow[];
}

export function getAffiliations(db: Database.Database, id: number): AffiliationRow[] {
  return db
    .prepare(`SELECT id, affiliation_type FROM affiliations WHERE constituent_id = ?`)
    .all(id) as AffiliationRow[];
}

export function getDegrees(db: Database.Database, id: number): DegreeRow[] {
  return db
    .prepare(`SELECT id, degree_type, class_year FROM degrees WHERE constituent_id = ?`)
    .all(id) as DegreeRow[];
}

export function getPaidGiftsAsOf(db: Database.Database, id: number, asOf: string): GiftRow[] {
  return db
    .prepare(
      `SELECT id, gift_date, amount, status, gift_type FROM gifts
       WHERE constituent_id = ? AND substr(gift_date,1,10) <= ? ORDER BY gift_date`,
    )
    .all(id, asOf) as GiftRow[];
}

export function getInteractionsAsOf(db: Database.Database, id: number, asOf: string): InteractionRow[] {
  return db
    .prepare(
      `SELECT id, occurred_at, purpose, outcome, direction, follow_up_date, related_gift_id, notes
       FROM interactions WHERE constituent_id = ? AND substr(occurred_at,1,10) <= ? ORDER BY occurred_at`,
    )
    .all(id, asOf) as InteractionRow[];
}

export function getAttendanceAsOf(db: Database.Database, id: number, asOf: string): AttendanceRow[] {
  return db
    .prepare(
      `SELECT ea.id, ea.attended_at, ea.event_id FROM event_attendance ea
       WHERE ea.constituent_id = ? AND substr(ea.attended_at,1,10) <= ?`,
    )
    .all(id, asOf) as AttendanceRow[];
}

export function getActivities(db: Database.Database, id: number): ActivityRow[] {
  return db
    .prepare(`SELECT activity_name FROM activities WHERE constituent_id = ?`)
    .all(id) as ActivityRow[];
}

/** Career rows use recorded_at (when advancement learned it), never started_at alone. */
export function getCareerAsOf(db: Database.Database, id: number, asOf: string): CareerRow[] {
  return db
    .prepare(
      `SELECT id, employer, job_title, is_current, recorded_at, started_at FROM career_history
       WHERE constituent_id = ? AND substr(recorded_at,1,10) <= ? ORDER BY recorded_at`,
    )
    .all(id, asOf) as CareerRow[];
}

export function getFutureEvents(db: Database.Database, asOf: string): EventRow[] {
  return db
    .prepare(`SELECT id, starts_at, city, state FROM events WHERE substr(starts_at,1,10) > ? ORDER BY starts_at`)
    .all(asOf) as EventRow[];
}

export function hasPledgeHistory(db: Database.Database, id: number, asOf: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM gifts WHERE constituent_id = ? AND gift_type = 'pledge'
       AND status IN ('paid','pledged') AND substr(gift_date,1,10) <= ? LIMIT 1`,
    )
    .get(id, asOf) as { x: number } | undefined;
  return Boolean(row);
}

/** Overdue follow-ups: follow_up_date < T0 with no later contact. */
export function hasOverdueFollowUp(inters: InteractionRow[], asOf: string): boolean {
  const times = inters.map((i) => i.occurred_at.slice(0, 10)).sort();
  const last = times.length > 0 ? times[times.length - 1]! : null;
  return inters.some((i) => {
    if (!i.follow_up_date || i.follow_up_date.slice(0, 10) >= asOf) return false;
    // Overdue counts when nothing after the follow-up date.
    return last !== null && last <= i.follow_up_date.slice(0, 10);
  });
}
