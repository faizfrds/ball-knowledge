import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  EXPECTED_CSV_HEADERS,
  INGEST_TABLES,
  REFERENCE_DIR,
  isPathInsideDir,
  resolveDataDir,
  resolveDbPath,
  resolveSchemaPath,
} from "./config.js";
import { foreignKeyErrors, initSchema, openDb, tableCount } from "./db.js";
import { normalizeValue, parseCsv, toCents } from "./normalize.js";

export interface IngestOptions {
  dataDir?: string;
  schemaPath?: string;
  dbPath?: string;
  force?: boolean;
}

export interface IngestChecks {
  schemaHash: string;
  allocationMismatches: number;
  postDeathGifts: number;
  postDeathInteractions: number;
}

export interface IngestResult {
  dbPath: string;
  counts: Record<string, number>;
  /** Pinned sha256 of the executed schema.sql (F7). */
  schemaHash?: string;
  /** Non-fatal invariant findings (post-death rows should be zero). */
  warnings?: string[];
  /** Invariant summary (allocation sums, post-death counts, schema hash). */
  checks?: IngestChecks;
}

function removeSidecars(p: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      fs.rmSync(`${p}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Order gift rows so `linked_parent_gift_id` parents insert before children.
 * Combined with `PRAGMA defer_foreign_keys = ON` this makes the gifts
 * self-FK robust to out-of-order CSV input (F7). */
export function orderGiftsRowsForInsert(
  rows: Record<string, string>[],
): Record<string, string>[] {
  return [...rows].sort((a, b) => {
    const ap = a.linked_parent_gift_id ? 1 : 0;
    const bp = b.linked_parent_gift_id ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return Number(a.id ?? 0) - Number(b.id ?? 0);
  });
}

/** Count gifts whose allocations do not sum to the gift amount (±1 cent).
 * Only gifts with at least one allocation row are checked. Uses integer
 * cents so binary-float SUM cannot hide cent errors (F12). */
export function checkAllocationSums(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT g.id AS id, g.amount AS amount, SUM(a.amount) AS allocSum
       FROM gifts g JOIN gift_allocations a ON a.gift_id = g.id
       GROUP BY g.id`,
    )
    .all() as { id: number; amount: string | number; allocSum: string | number }[];
  let mismatches = 0;
  for (const r of rows) {
    if (Math.abs(toCents(r.allocSum) - toCents(r.amount)) > 1) mismatches++;
  }
  return mismatches;
}

function countPostDeathViolations(db: Database.Database): {
  gifts: number;
  interactions: number;
} {
  let gifts = 0;
  let interactions = 0;
  try {
    gifts = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM gifts g JOIN constituents c ON c.id = g.constituent_id
           WHERE c.deceased_date IS NOT NULL AND c.deceased_date != ''
           AND substr(g.gift_date, 1, 10) > substr(c.deceased_date, 1, 10)`,
        )
        .get() as { n: number }
    ).n;
  } catch {
    gifts = 0;
  }
  try {
    interactions = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM interactions i JOIN constituents c ON c.id = i.constituent_id
           WHERE c.deceased_date IS NOT NULL AND c.deceased_date != ''
           AND substr(i.occurred_at, 1, 10) > substr(c.deceased_date, 1, 10)`,
        )
        .get() as { n: number }
    ).n;
  } catch {
    interactions = 0;
  }
  return { gifts, interactions };
}

/**
 * Load reference CSVs into SQLite.
 * - Preserves source `id` values (explicit INSERT, no remapping).
 * - Normalizes missing values: empty CSV field -> NULL; per-column booleans -> 1/0.
 * - Never writes to the source data dir; output defaults to ./data/givecampus.sqlite.
 * - Refuses to overwrite an existing DB unless `force` is set.
 * - Hardening (F7/F8/F9/F12/F14): refuses output paths inside the reference
 *   tree; builds to a temp file in the destination dir and atomically
 *   renames on success (a failed ingest never touches the existing DB);
 *   validates CSV headers/widths; enforces finite numerics; orders the gifts
 *   self-FK parents-first with deferred FKs; checks allocation sums and
 *   post-death invariants; pins the schema hash.
 */
export function ingest(options: IngestOptions = {}): IngestResult {
  const dataDir = path.resolve(resolveDataDir(options.dataDir));
  const schemaPath = path.resolve(resolveSchemaPath(options.schemaPath));
  const dbPath = path.resolve(resolveDbPath(options.dbPath));
  const referenceDir = path.resolve(REFERENCE_DIR);

  if (!fs.existsSync(dataDir)) throw new Error(`Data dir not found: ${dataDir}`);
  if (!fs.existsSync(schemaPath)) throw new Error(`Schema not found: ${schemaPath}`);
  // F7/F15: never let the output DB live inside (or collide with) the
  // read-only reference tree or the source inputs.
  if (
    isPathInsideDir(referenceDir, dbPath) ||
    isPathInsideDir(dataDir, dbPath) ||
    dbPath === schemaPath ||
    dbPath === dataDir
  ) {
    throw new Error(
      `Refusing to write database inside the reference/source tree: ${dbPath}`,
    );
  }
  if (fs.existsSync(dbPath) && !options.force) {
    throw new Error(`Refusing to overwrite existing database: ${dbPath} (pass force:true to rebuild)`);
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const tmpPath = `${dbPath}.tmp.${process.pid}`;
  removeSidecars(tmpPath);

  const schemaSql = fs.readFileSync(schemaPath, "utf-8");
  const schemaHash = crypto.createHash("sha256").update(schemaSql).digest("hex");
  const db: Database.Database = openDb(tmpPath);
  try {
    initSchema(db, schemaSql);
    db.pragma("defer_foreign_keys = ON");
    const counts: Record<string, number> = {};
    const insertMany = (table: string, header: string[], rows: Record<string, string>[]) => {
      const cols = header.map((c) => `"${c}"`).join(", ");
      const placeholders = header.map(() => "?").join(", ");
      const stmt = db.prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`);
      const txn = db.transaction((batch: Record<string, string>[]) => {
        for (const r of batch) {
          stmt.run(...header.map((c) => normalizeValue(table, c, r[c])));
        }
      });
      txn(rows);
    };
    for (const table of INGEST_TABLES) {
      const csvPath = path.join(dataDir, `${table}.csv`);
      if (!fs.existsSync(csvPath)) throw new Error(`Missing CSV: ${csvPath}`);
      const { header, rows } = parseCsv(fs.readFileSync(csvPath, "utf-8"), {
        expectedHeader: EXPECTED_CSV_HEADERS[table],
        sourceLabel: csvPath,
      });
      const ordered = table === "gifts" ? orderGiftsRowsForInsert(rows) : rows;
      insertMany(table, header, ordered);
      const n = tableCount(db, table);
      if (n !== rows.length) {
        throw new Error(
          `Row count mismatch for ${table}: parsed ${rows.length} rows but DB holds ${n}`,
        );
      }
      counts[table] = n;
    }
    const fkErrors = foreignKeyErrors(db);
    if (fkErrors.length > 0) {
      throw new Error(`Foreign-key validation failed: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    const allocationMismatches = checkAllocationSums(db);
    if (allocationMismatches > 0) {
      throw new Error(
        `Allocation invariant failed: ${allocationMismatches} gift(s) whose allocations do not sum to the gift amount`,
      );
    }
    const postDeath = countPostDeathViolations(db);
    const warnings: string[] = [];
    if (postDeath.gifts > 0) {
      warnings.push(`post_death_gifts=${postDeath.gifts} gifts dated after constituents.deceased_date`);
    }
    if (postDeath.interactions > 0) {
      warnings.push(
        `post_death_interactions=${postDeath.interactions} interactions dated after constituents.deceased_date`,
      );
    }
    db.exec("ANALYZE");
    db.close();

    // Atomic publish: only now replace the destination (force) and rename.
    if (fs.existsSync(dbPath) && options.force) {
      removeSidecars(dbPath);
    }
    fs.renameSync(tmpPath, dbPath);
    removeSidecars(tmpPath);
    const checks: IngestChecks = {
      schemaHash,
      allocationMismatches,
      postDeathGifts: postDeath.gifts,
      postDeathInteractions: postDeath.interactions,
    };
    return { dbPath, counts, schemaHash, warnings, checks };
  } catch (err) {
    try {
      if (db.open) db.close();
    } catch {
      /* ignore */
    }
    // Clean up only the temp build — the existing destination DB (if any)
    // is never deleted on failure (atomicity, F7).
    removeSidecars(tmpPath);
    throw err;
  }
}
