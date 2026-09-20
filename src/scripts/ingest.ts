#!/usr/bin/env tsx
/** `npm run ingest` — build ./data/givecampus.sqlite from read-only reference CSVs. */
import { ingest } from "../ingest.js";

const force = process.argv.includes("--force");
const result = ingest({ force });
console.log(`Ingested into ${result.dbPath}`);
for (const [table, n] of Object.entries(result.counts)) {
  console.log(`  ${table}: ${n}`);
}
