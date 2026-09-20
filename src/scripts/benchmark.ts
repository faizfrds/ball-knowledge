#!/usr/bin/env tsx
/**
 * `npx tsx src/scripts/benchmark.ts [--db path] [--train T0] [--dev T0,...]
 *   [--heldout T0] [--out dir] [--jev jev_scores.csv]`
 * Runs the GiveCampus worklist benchmark against data/givecampus.sqlite;
 * if the DB is missing it invokes the existing ingest first.
 * Emits machine-readable JSON + readable markdown/table, prints the table.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../db.js";
import { resolveDbPath } from "../config.js";
import { runBenchmark, renderMarkdown } from "../benchmark/run.js";
import { ingest } from "../ingest.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const dbPath = arg("--db", resolveDbPath())!;
const train = arg("--train", "2023-08-31")!;
const dev = (arg("--dev", "2024-08-31")!).split(",").map((s) => s.trim());
const heldOut = arg("--heldout", "2025-08-31")!;
const outDir = arg("--out", path.join("data", "benchmark"))!;
const jevPath = arg("--jev", undefined);

if (!fs.existsSync(dbPath)) {
  console.log(`DB missing at ${dbPath}; running existing ingest first.`);
  ingest({});
}

const db: Database.Database = openDb(dbPath);
db.pragma("query_only = ON");
try {
  const report = runBenchmark(db, {
    dbPath,
    trainCutoff: train,
    devCutoffs: dev,
    heldOutCutoff: heldOut,
    jevPath,
  });
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = heldOut;
  fs.writeFileSync(path.join(outDir, `benchmark_${stamp}.json`), JSON.stringify(report, null, 2));
  const md = renderMarkdown(report);
  fs.writeFileSync(path.join(outDir, `benchmark_${stamp}.md`), md);
  console.log(md);
  console.log(`Wrote ${outDir}/benchmark_${stamp}.json and benchmark_${stamp}.md`);
} finally {
  db.close();
}
