import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { INGEST_TABLES, resolveDataDir, resolveDbPath, resolveSchemaPath } from "./config.js";
import { foreignKeyErrors, initSchema, openDb, tableCount } from "./db.js";
import { normalizeValue, parseCsv } from "./normalize.js";

export interface IngestOptions {
  dataDir?: string;
  schemaPath?: string;
  dbPath?: string;
  force?: boolean;
}

export interface IngestResult {
  dbPath: string;
  counts: Record<string, number>;
}

/**
 * Load reference CSVs into SQLite.
 * - Preserves source `id` values (explicit INSERT, no remapping).
 * - Normalizes missing values: empty CSV field -> NULL; booleans -> 1/0.
 * - Never writes to the source data dir; output defaults to ./data/givecampus.sqlite.
 * - Refuses to overwrite an existing DB unless `force` is set.
 */
export function ingest(options: IngestOptions = {}): IngestResult {
  const dataDir = resolveDataDir(options.dataDir);
  const schemaPath = resolveSchemaPath(options.schemaPath);
  const dbPath = resolveDbPath(options.dbPath);

  if (!fs.existsSync(dataDir)) throw new Error(`Data dir not found: ${dataDir}`);
  if (!fs.existsSync(schemaPath)) throw new Error(`Schema not found: ${schemaPath}`);
  if (fs.existsSync(dbPath) && !options.force) {
    throw new Error(`Refusing to overwrite existing database: ${dbPath} (pass force:true to rebuild)`);
  }
  if (fs.existsSync(dbPath) && options.force) fs.rmSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const schemaSql = fs.readFileSync(schemaPath, "utf-8");
  const db: Database.Database = openDb(dbPath);
  try {
    initSchema(db, schemaSql);
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
      const { header, rows } = parseCsv(fs.readFileSync(csvPath, "utf-8"));
      insertMany(table, header, rows);
      counts[table] = tableCount(db, table);
    }
    const fkErrors = foreignKeyErrors(db);
    if (fkErrors.length > 0) {
      throw new Error(`Foreign-key validation failed: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    return { dbPath, counts };
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dbPath);
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    try {
      if (db.open) db.close();
    } catch {
      /* ignore */
    }
  }
}
