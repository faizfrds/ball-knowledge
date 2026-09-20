import type Database from "better-sqlite3";
import { buildConstituentFeatures, type ConstituentFeatures } from "./features.js";
import { AS_OF_DATE } from "./config.js";

/** Parameterized, as-of-safe reads over the ingested SQLite DB. */

export function getConstituent(db: Database.Database, id: number) {
  return db.prepare(`SELECT * FROM constituents WHERE id = ?`).get(id);
}

export function listConstituents(
  db: Database.Database,
  opts: { limit?: number; offset?: number } = {},
) {
  const limit = Math.min(opts.limit ?? 25, 200);
  const offset = opts.offset ?? 0;
  return db
    .prepare(`SELECT * FROM constituents ORDER BY id LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

export function getGiftsForConstituent(
  db: Database.Database,
  constituentId: number,
  asOf: string = AS_OF_DATE,
) {
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

export function getAttendanceForConstituent(db: Database.Database, constituentId: number) {
  return db
    .prepare(`SELECT id, attended_at FROM event_attendance WHERE constituent_id = ?`)
    .all(constituentId) as { id: number; attended_at: string }[];
}

/** Full bundle: raw rows + deterministic features + source evidence. */
export function getConstituentBundle(
  db: Database.Database,
  constituentId: number,
  asOf: string = AS_OF_DATE,
): { constituent: unknown; features: ConstituentFeatures } {
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
    attendance: getAttendanceForConstituent(db, constituentId).filter(
      (a) => a.attended_at.slice(0, 10) <= asOf,
    ),
    asOf,
  });
  return { constituent, features };
}
