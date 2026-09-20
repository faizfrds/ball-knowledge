import Database from "better-sqlite3";
import fs from "node:fs";
import { INGEST_TABLES } from "./config.js";

export interface OpenDbOptions {
  /** Open read-only (no file creation, no WAL writes). Runtime default. */
  readonly?: boolean;
  /** SQLite busy timeout in ms (default 5000). */
  busyTimeoutMs?: number;
}

/** Open the SQLite DB with hardening defaults:
 * - `busy_timeout` (default 5000ms) so ingest+server overlap retries instead
 *   of flaking with SQLITE_BUSY.
 * - `foreign_keys = ON` always.
 * - RW opens use WAL + synchronous=NORMAL; readonly opens never create the
 *   file (missing file throws instead of auto-creating an empty DB) and
 *   never change the journal mode. */
export function openDb(dbPath: string, opts: OpenDbOptions = {}): Database.Database {
  const busyTimeout = opts.busyTimeoutMs ?? 5000;
  if (opts.readonly) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database file not found: ${dbPath}`);
    }
    const db = new Database(dbPath, { readonly: true });
    db.pragma(`busy_timeout = ${busyTimeout}`);
    db.pragma("foreign_keys = ON");
    return db;
  }
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${busyTimeout}`);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Read-only open for runtime paths (server, jobs, benchmarks).
 * Throws when the file is missing instead of creating an empty DB. */
export function openReadonlyDb(dbPath: string, busyTimeoutMs = 5000): Database.Database {
  return openDb(dbPath, { readonly: true, busyTimeoutMs });
}

/** Apply executable schema (reference schema.sql). Idempotent for fresh DBs. */
export function initSchema(db: Database.Database, schemaSql: string): void {
  db.exec(schemaSql);
}

/** Row count with an allowlist so the table identifier can never be injected.
 * Only INGEST_TABLES are countable (F14). */
export function tableCount(db: Database.Database, table: string): number {
  if (!(INGEST_TABLES as readonly string[]).includes(table)) {
    throw new Error(`Unknown table: ${table}`);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM "${table}"`)
    .get() as { n: number };
  return row.n;
}

export function foreignKeyErrors(db: Database.Database): unknown[] {
  return db.prepare("PRAGMA foreign_key_check").all();
}

export function assertReadableFile(p: string, label: string): void {
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${label}: ${p}`);
  }
}
