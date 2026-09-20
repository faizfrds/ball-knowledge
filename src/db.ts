import Database from "better-sqlite3";
import fs from "node:fs";

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Apply executable schema (reference schema.sql). Idempotent for fresh DBs. */
export function initSchema(db: Database.Database, schemaSql: string): void {
  db.exec(schemaSql);
}

export function tableCount(db: Database.Database, table: string): number {
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
