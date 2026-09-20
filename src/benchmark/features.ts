/**
 * As-of-safe batch feature builder for the benchmark slice.
 * Leakage rules (mirrors design:givecampus:evaluation):
 * - Gifts: status='paid' AND gift_type != 'recurring_parent', gift_date <= T0.
 *   (Installments count; parent commitment headers never do.)
 * - Interactions: occurred_at <= T0. follow_up_date read only from those rows.
 * - Attendance: attended_at <= T0. Future events (starts_at > T0) used for
 *   why-now only, never as engagement history.
 * - Career: recorded_at <= T0 ONLY — started_at alone is never sufficient.
 * - Opportunities / campaigns.status / funds.active are NEVER read here
 *   (post-T0 outcomes / current flags that cannot be as-of reconstructed).
 * - Degrees / activities are slow-moving snapshots (no event timestamp).
 */
import type Database from "better-sqlite3";

export const CONNECTED_OUTCOMES = new Set([
  "connected",
  "replied",
  "meeting_booked",
  "gift_received",
  "pledged",
]);

const SENIORITY_HINT = /chief|officer|president|partner|founder|director|\bvp\b|vice/i;
const UG_DEGREES = new Set(["B.A.", "A.B.", "B.S.", "B.B.A."]);

export interface FeatureVector {
  constituentId: number;
  // RFM raw inputs
  daysSinceLastPaid: number | null; // null = never gave as-of T0
  paidCount5y: number;
  paidTotal5y: number;
  maxSinglePaid: number | null;
  // Normalized 0-1 subscores
  r: number;
  f: number;
  m: number;
  e: number;
  n: number;
  c: number;
  recencyUnknown: boolean;
  // Why-now evidence flags (for reporting, not scoring)
  whyNow:
    | "recent_gift"
    | "overdue_followup"
    | "career_signal"
    | "nearby_event"
    | "reunion"
    | "none";
}

interface GiftRow {
  constituent_id: number;
  gift_date: string;
  amount: number;
  gift_type: string;
}
interface InteractionRow {
  constituent_id: number;
  occurred_at: string;
  outcome: string;
  follow_up_date: string | null;
}
interface AttendanceRow {
  constituent_id: number;
  attended_at: string;
}
interface CareerRow {
  constituent_id: number;
  job_title: string | null;
  is_current: number;
  recorded_at: string;
}
interface DegreeRow {
  constituent_id: number;
  degree_type: string | null;
  class_year: number | null;
}
interface ActivityRow {
  constituent_id: number;
  activity_name: string;
}

export function ymd(dateOrTs: string): string {
  return dateOrTs.slice(0, 10);
}

export function daysBetween(aYmd: string, bYmd: string): number {
  return Math.round(
    (Date.parse(`${bYmd}T00:00:00Z`) - Date.parse(`${aYmd}T00:00:00Z`)) / 86_400_000,
  );
}

export function addDays(ymdStr: string, days: number): string {
  return new Date(Date.parse(`${ymdStr}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export interface Snapshot {
  t0: string;
  gifts: GiftRow[];
  interactions: InteractionRow[];
  attendance: AttendanceRow[];
  career: CareerRow[];
  degrees: DegreeRow[];
  activities: ActivityRow[];
  futureEvents: { city: string; state: string; starts_at: string }[];
}

/** One batched load per cutoff; all SQL predicates carry the T0 guard. */
export function loadSnapshot(db: Database.Database, t0: string): Snapshot {
  const gifts = db
    .prepare(
      `SELECT constituent_id, gift_date, amount, gift_type FROM gifts
       WHERE status = 'paid' AND gift_type != 'recurring_parent'
         AND substr(gift_date, 1, 10) <= ?`,
    )
    .all(t0) as GiftRow[];
  const interactions = db
    .prepare(
      `SELECT constituent_id, occurred_at, outcome, follow_up_date FROM interactions
       WHERE substr(occurred_at, 1, 10) <= ?`,
    )
    .all(t0) as InteractionRow[];
  const attendance = db
    .prepare(
      `SELECT constituent_id, attended_at FROM event_attendance
       WHERE substr(attended_at, 1, 10) <= ?`,
    )
    .all(t0) as AttendanceRow[];
  // recorded_at (when advancement learned it) is the ONLY as-of-safe career clock.
  const career = db
    .prepare(
      `SELECT constituent_id, job_title, is_current, recorded_at FROM career_history
       WHERE substr(recorded_at, 1, 10) <= ?`,
    )
    .all(t0) as CareerRow[];
  const degrees = db
    .prepare(
      `SELECT constituent_id, degree_type, class_year FROM degrees`,
    )
    .all() as DegreeRow[];
  const activities = db
    .prepare(`SELECT constituent_id, activity_name FROM activities`)
    .all() as ActivityRow[];
  // Future events: why-now signal only (no attendance rows exist for them).
  const futureEvents = db
    .prepare(
      `SELECT city, state, starts_at FROM events
       WHERE substr(starts_at, 1, 10) > ? AND substr(starts_at, 1, 10) <= ?`,
    )
    .all(t0, addDays(t0, 30)) as Snapshot["futureEvents"];
  return { t0, gifts, interactions, attendance, career, degrees, activities, futureEvents };
}

function groupBy<T>(rows: T[], key: (r: T) => number): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function buildFeatures(
  constituentId: number,
  city: string | null,
  state: string | null,
  snap: Snapshot,
  giftMap: Map<number, GiftRow[]>,
  interMap: Map<number, InteractionRow[]>,
  attMap: Map<number, AttendanceRow[]>,
  careerMap: Map<number, CareerRow[]>,
  degreeMap: Map<number, DegreeRow[]>,
  activityMap: Map<number, ActivityRow[]>,
): FeatureVector {
  const { t0 } = snap;
  const year = Number(t0.slice(0, 4));
  const gifts = giftMap.get(constituentId) ?? [];
  const paidDates = gifts.map((g) => ymd(g.gift_date)).sort();
  const lastPaid = paidDates.length > 0 ? paidDates[paidDates.length - 1]! : null;
  const daysSinceLastPaid = lastPaid ? daysBetween(lastPaid, t0) : null;

  const fiveAgo = addDays(t0, -5 * 365);
  const in5y = gifts.filter((g) => ymd(g.gift_date) > fiveAgo);
  const paidCount5y = in5y.length;
  const paidTotal5y = in5y.reduce((s, g) => s + Number(g.amount), 0);
  const maxSinglePaid =
    gifts.length > 0 ? Math.max(...gifts.map((g) => Number(g.amount))) : null;

  const r = daysSinceLastPaid === null ? 0 : 1 / (1 + daysSinceLastPaid / 180);
  const f = Math.min(1, paidCount5y / 5);
  const m = Math.min(1, Math.log(1 + paidTotal5y) / Math.log(1 + 50000));

  const inters = interMap.get(constituentId) ?? [];
  const twoAgo = addDays(t0, -2 * 365);
  const oneAgo = addDays(t0, -365);
  const atts = attMap.get(constituentId) ?? [];
  const events2y = atts.filter((a) => ymd(a.attended_at) > twoAgo).length;
  const connected1y = inters.filter(
    (i) => ymd(i.occurred_at) > oneAgo && CONNECTED_OUTCOMES.has(i.outcome),
  ).length;
  const distinctActivities = new Set(
    (activityMap.get(constituentId) ?? []).map((a) => a.activity_name),
  ).size;
  const e = Math.min(1, (0.5 * events2y + 0.3 * connected1y + 0.2 * distinctActivities) / 3);

  // Why-now: max of applicable triggers.
  let n = 0;
  let whyNow: FeatureVector["whyNow"] = "none";
  const thirtyAgo = addDays(t0, -30);
  if (lastPaid !== null && lastPaid > thirtyAgo) {
    n = 0.9;
    whyNow = "recent_gift";
  }
  const overdue = inters.some(
    (i) =>
      i.follow_up_date !== null &&
      ymd(i.follow_up_date) < t0 &&
      !inters.some(
        (j) => ymd(j.occurred_at) > ymd(i.follow_up_date!) && ymd(j.occurred_at) <= t0,
      ),
  );
  if (overdue && 0.8 > n) {
    n = 0.8;
    whyNow = "overdue_followup";
  }
  const ninetyAgo = addDays(t0, -90);
  const careerRows = careerMap.get(constituentId) ?? [];
  const promo = careerRows.some(
    (c) => ymd(c.recorded_at) > ninetyAgo && c.is_current === 1,
  );
  if (promo && 0.7 > n) {
    n = 0.7;
    whyNow = "career_signal";
  }
  const nearby = snap.futureEvents.some(
    (ev) =>
      city !== null && state !== null && ev.city === city && ev.state === state,
  );
  if (nearby && 0.7 > n) {
    n = 0.7;
    whyNow = "nearby_event";
  }
  const ugYears = (degreeMap.get(constituentId) ?? [])
    .filter((d) => d.degree_type !== null && UG_DEGREES.has(d.degree_type) && d.class_year !== null)
    .map((d) => d.class_year as number);
  const reunion =
    ugYears.length > 0 && (year - Math.min(...ugYears)) % 5 === 0;
  if (reunion && 0.6 > n) {
    n = 0.6;
    whyNow = "reunion";
  }

  // Capacity proxy: recorded giving first, seniority hint capped at 0.1 weight.
  const pledgeFlag = (() => {
    // Pledge history uses paid-cash rows of gift_type 'pledge' plus any
    // pledged-status row would leak intent; paid pledge rows are cash received.
    // giftMap holds paid rows only, so check gift_type='pledge' among them.
    return gifts.some((g) => g.gift_type === "pledge") ? 1 : 0;
  })();
  const seniorityHint = careerRows.some(
    (c) => c.is_current === 1 && c.job_title !== null && SENIORITY_HINT.test(c.job_title),
  )
    ? 1
    : 0;
  const c =
    maxSinglePaid === null
      ? 0
      : Math.min(
          1,
          (0.7 * Math.log(1 + maxSinglePaid)) / Math.log(1 + 25000) +
            0.2 * pledgeFlag +
            0.1 * seniorityHint,
        );

  return {
    constituentId,
    daysSinceLastPaid,
    paidCount5y,
    paidTotal5y: Math.round(paidTotal5y * 100) / 100,
    maxSinglePaid,
    r,
    f,
    m,
    e,
    n,
    c,
    recencyUnknown: lastPaid === null,
    whyNow,
  };
}

/** Build vectors for the whole eligible population at T0. */
export function buildAllFeatures(
  db: Database.Database,
  population: { id: number; city: string | null; state: string | null }[],
  t0: string,
  snap?: Snapshot,
): Map<number, FeatureVector> {
  const s = snap ?? loadSnapshot(db, t0);
  const giftMap = groupBy(s.gifts, (g) => g.constituent_id);
  const interMap = groupBy(s.interactions, (i) => i.constituent_id);
  const attMap = groupBy(s.attendance, (a) => a.constituent_id);
  const careerMap = groupBy(s.career, (c) => c.constituent_id);
  const degreeMap = groupBy(s.degrees, (d) => d.constituent_id);
  const activityMap = groupBy(s.activities, (a) => a.constituent_id);
  const out = new Map<number, FeatureVector>();
  for (const p of population) {
    out.set(
      p.id,
      buildFeatures(
        p.id, p.city, p.state, s,
        giftMap, interMap, attMap, careerMap, degreeMap, activityMap,
      ),
    );
  }
  return out;
}

/**
 * Outcome labels for window W = (T0, T0+90d]: paid non-parent gifts only.
 * Excludes failed/refunded/pending/pledged and gifts after deceased_date.
 */
export function loadOutcomes(
  db: Database.Database,
  t0: string,
  windowDays = 90,
): { donors: Set<number>; amounts: Map<number, number> } {
  const end = addDays(t0, windowDays);
  const rows = db
    .prepare(
      `SELECT g.constituent_id AS cid, g.amount AS amount
       FROM gifts g JOIN constituents c ON c.id = g.constituent_id
       WHERE g.status = 'paid' AND g.gift_type != 'recurring_parent'
         AND substr(g.gift_date, 1, 10) > ?
         AND substr(g.gift_date, 1, 10) <= ?
         AND (c.deceased_date IS NULL OR substr(g.gift_date, 1, 10) <= substr(c.deceased_date, 1, 10))`,
    )
    .all(t0, end) as { cid: number; amount: number }[];
  const donors = new Set<number>();
  const amounts = new Map<number, number>();
  for (const r of rows) {
    donors.add(r.cid);
    amounts.set(r.cid, Math.round(((amounts.get(r.cid) ?? 0) + Number(r.amount)) * 100) / 100);
  }
  return { donors, amounts };
}
