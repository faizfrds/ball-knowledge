import type Database from "better-sqlite3";
import { buildConstituentFeatures, type ConstituentFeatures } from "./features.js";
import { AS_OF_DATE } from "./config.js";

/** Parameterized, as-of-safe reads over the ingested SQLite DB. */

const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate an as-of date: strict YYYY-MM-DD and never after the dataset
 * as-of (F2). Backtests use T0 <= AS_OF_DATE; invalid or future values throw
 * so future rows can never leak through a bad parameter. */
export function assertAsOf(asOf: string): void {
  if (!AS_OF_RE.test(asOf)) {
    throw new Error(`invalid_asof: expected YYYY-MM-DD, got ${JSON.stringify(asOf)}`);
  }
  if (asOf > AS_OF_DATE) {
    throw new Error(`future_asof: ${asOf} is after dataset as-of ${AS_OF_DATE}`);
  }
}

function clampPagination(opts: { limit?: number; offset?: number }): {
  limit: number;
  offset: number;
} {
  const limitRaw = opts.limit ?? 25;
  const offsetRaw = opts.offset ?? 0;
  if (
    typeof limitRaw !== "number" ||
    typeof offsetRaw !== "number" ||
    !Number.isFinite(limitRaw) ||
    !Number.isFinite(offsetRaw)
  ) {
    throw new Error("invalid_pagination: limit/offset must be finite numbers");
  }
  const limit = Math.floor(limitRaw);
  const offset = Math.floor(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("invalid_pagination: limit must be an integer 1..200");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("invalid_pagination: offset must be an integer >= 0");
  }
  return { limit, offset };
}

export function getConstituent(db: Database.Database, id: number) {
  return db.prepare(`SELECT * FROM constituents WHERE id = ?`).get(id);
}

/** Legacy list (array return preserved for server compat) with safe
 * pagination clamps. Prefer listConstituentsPaged for projection + total. */
export function listConstituents(
  db: Database.Database,
  opts: { limit?: number; offset?: number } = {},
) {
  const { limit, offset } = clampPagination(opts);
  return db
    .prepare(`SELECT * FROM constituents ORDER BY id LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

/** Allowlisted list projection (F16): avoids SELECT * over-fetch of
 * lat/long/email internals for list views. */
export const CONSTITUENT_LIST_COLUMNS = [
  "id",
  "preferred_name",
  "entity_type",
  "email_status",
  "phone_status",
  "city",
  "state",
] as const;

export type ConstituentListColumn = (typeof CONSTITUENT_LIST_COLUMNS)[number];

/** Paged list with projection allowlist + total so clients can page safely. */
export function listConstituentsPaged(
  db: Database.Database,
  opts: {
    limit?: number;
    offset?: number;
    columns?: readonly string[];
  } = {},
): {
  rows: unknown[];
  total: number;
  limit: number;
  offset: number;
} {
  const { limit, offset } = clampPagination(opts);
  const cols = opts.columns ?? ["id", "preferred_name", "entity_type", "email_status", "phone_status"];
  if (cols.length === 0) throw new Error("invalid_projection: at least one column required");
  for (const c of cols) {
    if (!(CONSTITUENT_LIST_COLUMNS as readonly string[]).includes(c)) {
      throw new Error(`invalid_projection: unknown column ${JSON.stringify(c)}`);
    }
  }
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM constituents`).get() as { n: number }
  ).n;
  const colSql = cols.map((c) => `"${c}"`).join(", ");
  const rows = db
    .prepare(`SELECT ${colSql} FROM constituents ORDER BY id LIMIT ? OFFSET ?`)
    .all(limit, offset);
  return { rows, total, limit, offset };
}

export function getGiftsForConstituent(
  db: Database.Database,
  constituentId: number,
  asOf: string = AS_OF_DATE,
) {
  assertAsOf(asOf);
  return db
    .prepare(
      `SELECT id, gift_date, amount, status, gift_type
       FROM gifts WHERE constituent_id = ? AND substr(gift_date, 1, 10) <= ? ORDER BY gift_date`,
    )
    .all(constituentId, asOf) as {
    id: number;
    gift_date: string;
    amount: number;
    status: string;
    gift_type: string;
  }[];
}

export function getInteractionsForConstituent(
  db: Database.Database,
  constituentId: number,
  asOf: string = AS_OF_DATE,
) {
  assertAsOf(asOf);
  return db
    .prepare(
      `SELECT id, occurred_at, follow_up_date
       FROM interactions WHERE constituent_id = ? AND substr(occurred_at, 1, 10) <= ? ORDER BY occurred_at`,
    )
    .all(constituentId, asOf) as {
    id: number;
    occurred_at: string;
    follow_up_date: string | null;
  }[];
}

/** Attendance reads enforce the as-of cutoff in SQL (F2) so direct callers
 * can no longer bypass it; the bundle keeps an in-memory filter as
 * defense-in-depth. */
export function getAttendanceForConstituent(
  db: Database.Database,
  constituentId: number,
  asOf: string = AS_OF_DATE,
) {
  assertAsOf(asOf);
  return db
    .prepare(
      `SELECT id, attended_at FROM event_attendance
       WHERE constituent_id = ? AND substr(attended_at, 1, 10) <= ? ORDER BY attended_at`,
    )
    .all(constituentId, asOf) as { id: number; attended_at: string }[];
}

/** Full bundle: raw rows + deterministic features + source evidence. */
export function getConstituentBundle(
  db: Database.Database,
  constituentId: number,
  asOf: string = AS_OF_DATE,
): { constituent: unknown; features: ConstituentFeatures } {
  assertAsOf(asOf);
  const constituent = getConstituent(db, constituentId) as {
    id: number;
    deceased: number;
    do_not_solicit: number;
  } | undefined;
  if (!constituent) throw new Error(`Constituent not found: ${constituentId}`);
  const features = buildConstituentFeatures({
    constituent,
    gifts: getGiftsForConstituent(db, constituentId, asOf),
    interactions: getInteractionsForConstituent(db, constituentId, asOf),
    attendance: getAttendanceForConstituent(db, constituentId, asOf).filter(
      (a) => a.attended_at.slice(0, 10) <= asOf,
    ),
    asOf,
  });
  return { constituent, features };
}
