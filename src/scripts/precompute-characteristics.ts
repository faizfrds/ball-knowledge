#!/usr/bin/env tsx
/**
 * Precompute Jev yes/no characteristics over a candidate pool.
 *
 * Simulates the "last 100 requests": the deterministic 100-characteristic
 * bank (giving recency/bands, frequency, engagement, attendance, career,
 * permissions, compounds) is materialized per pool constituent via Jev noul
 * questions, chunked into systemOne calls and persisted to a gitignored
 * SQLite cache so later pipeline lookups become cache hits.
 *
 * Usage:
 *   npx tsx src/scripts/precompute-characteristics.ts [--db data/givecampus.sqlite]
 *     [--as-of 2026-08-31] [--pool-cap 150 | --all] [--char-ids id1,id2,...]
 *     [--chunk 25] [--concurrency 4]
 *     [--max-live-calls 1500] [--cache data/characteristic-cache.sqlite]
 *     [--out data/characteristics] [--mock]
 *
 * DEFAULT SAMPLE: bounded by --pool-cap (currently limited to 150 constituents). This
 * is a PRECOMPUTE optimization, NOT a benchmark claim and NOT full-population evidence.
 * --mock answers via the deterministic code mirror (no network, no key) for smoke tests.
 * Output contains ids and aggregated verdict counts only (never PII).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { resolveDbPath, AS_OF_DATE } from "../config.js";
import { loadServerEnv } from "../env.js";
import { TypesafeJevClient } from "../givecampus/jev.js";
import { buildLivePool, JEV_INPUT_USD_PER_MTOK, JEV_LIVE_MODEL_PIN, JEV_LIVE_MODEL_FALLBACK } from "../benchmark/jev-live.js";
import { getEligiblePopulation } from "../benchmark/eligibility.js";
import {
  LocalCharacteristicClient,
  MapCharacteristicCache,
  precomputeCharacteristics,
  SqliteCharacteristicCache,
  type PrecomputeResult,
  type Verdict,
} from "../characteristics/precompute.js";
import { buildCharacteristicQuestions } from "../characteristics/question-library.js";

const DEFAULT_POOL_CAP = 150;
const DEFAULT_CHUNK = 25;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function summarizeVerdicts(result: PrecomputeResult, questionIds: string[]) {
  const counts = new Map<string, { yes: number; no: number; uncertain: number }>();
  for (const qid of questionIds) counts.set(qid, { yes: 0, no: 0, uncertain: 0 });
  for (const verdicts of result.verdictsByConstituent.values()) {
    for (const [qid, verdict] of Object.entries(verdicts)) {
      const entry = counts.get(qid) ?? { yes: 0, no: 0, uncertain: 0 };
      entry[verdict] += 1;
      counts.set(qid, entry);
    }
  }
  return counts;
}

async function main() {
  loadServerEnv();
  const dbPath = arg("--db", resolveDbPath())!;
  const asOf = arg("--as-of", AS_OF_DATE)!;
  const poolCap = Number(arg("--pool-cap", String(DEFAULT_POOL_CAP)));
  const chunkSize = Number(arg("--chunk", String(DEFAULT_CHUNK)));
  const concurrency = Number(arg("--concurrency", "4"));
  const maxLiveCalls = Number(arg("--max-live-calls", "1500"));
  const cachePath = arg("--cache", path.join("data", "characteristic-cache.sqlite"))!;
  const outDir = arg("--out", path.join("data", "characteristics"))!;
  const mock = argFlag("--mock");
  const allPopulation = argFlag("--all");
  const charIdsArg = arg("--char-ids");
  if (!fs.existsSync(dbPath)) throw new Error(`DB missing: ${dbPath}`);
  if (!Number.isInteger(poolCap) || poolCap < 1 || (allPopulation ? poolCap > 30_000 : poolCap > 5000)) {
    throw new Error(`--pool-cap must be 1..${allPopulation ? "30_000" : "5000"}`);
  }

  const live = !mock;
  const db = new Database(dbPath, { readonly: true });
  const cache = live ? new SqliteCharacteristicCache(cachePath) : new MapCharacteristicCache();
  try {
    const population = getEligiblePopulation(db, asOf)
      .map((p) => p.id)
      .sort((a, b) => a - b);
    if (population.length === 0) throw new Error(`Eligible population empty at ${asOf}`);
    const poolIds = allPopulation ? population.slice(0, poolCap) : buildLivePool(db, asOf, { cap: poolCap }).poolIds;
    const bank = buildCharacteristicQuestions();
    const selectedIds = charIdsArg
      ? String(charIdsArg)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : bank.map((q) => q.id);
    const questions = bank.filter((q) => selectedIds.includes(q.id));
    const missing = selectedIds.filter((id) => !questions.some((q) => q.id === id));
    if (missing.length > 0) throw new Error(`Unknown characteristic ids: ${missing.join(", ")}`);
    const client = live
      ? new TypesafeJevClient({ maxRetries: 2, timeoutMs: 20_000 })
      : new LocalCharacteristicClient();
    const result = await precomputeCharacteristics({
      db,
      poolIds,
      asOf,
      client,
      cache,
      questions,
      chunkSize,
      models: [JEV_LIVE_MODEL_PIN, JEV_LIVE_MODEL_FALLBACK],
      concurrency,
      maxLiveCalls,
    });
    const questionIds = questions.map((q) => q.id);
    const counts = summarizeVerdicts(result, questionIds);
    const uncached = result.records.filter((r) => !r.cacheHit && !r.error).map((r) => r.latencyMs).sort((a, b) => a - b);
    // Enumerate the simulated request log (one row per characteristic).
    const requestLog = [] as string[];
    const perQuestionYesRate: { id: string; yesPct: number }[] = [];
    for (const [i, qid] of questionIds.entries()) requestLog.push(`r${String(i + 1).padStart(3, "0")}_${qid}`);
    for (const [qid, c] of counts) {
      const judged = c.yes + c.no;
      perQuestionYesRate.push({ id: qid, yesPct: judged > 0 ? Math.round((c.yes / judged) * 1000) / 10 : 0 });
    }
    perQuestionYesRate.sort((a, b) => b.yesPct - a.yesPct || (a.id < b.id ? -1 : 1));
    const verdictMap: Record<string, Record<string, Verdict>> = {};
    for (const [id, verdicts] of result.verdictsByConstituent) verdictMap[String(id)] = verdicts;

    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, `characteristics-${asOf}.json`);
    const mdPath = path.join(outDir, `characteristics-${asOf}.md`);
    const costUsd = Math.round((result.inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MTOK * 1_000_000) / 1_000_000;
    const top = perQuestionYesRate.slice(0, 15);
    const bottom = [...perQuestionYesRate].reverse().slice(0, 15);
    const row = (qid: string) => {
      const c = counts.get(qid)!;
      return `| r | ${qid} | ${c.yes} | ${c.no} | ${c.uncertain} |`;
    };
    const md = [
      `# Jev characteristic precompute @ ${asOf}`,
      "",
      `Pool: ${poolIds.length} constituents (buildLivePool cap ${poolCap}); bank: ${result.questionCount} yes/no characteristics; chunk size ${chunkSize}.`,
      "",
      `Mode: ${live ? "live Jev" : "local deterministic mock (code mirror)"}. Live calls ${result.liveCalls}, cache hits ${result.cacheHits}, errors ${result.errors.length}, fallback used ${result.fallbackUsed}.`,
      `Tokens: input ${result.inputTokens}, output ${result.outputTokens}; est. cost $${costUsd.toFixed(6)} @ $${JEV_INPUT_USD_PER_MTOK}/M input (output free).`,
      `Latency (uncached, ms): p50 ${percentile(uncached, 0.5)}, p95 ${percentile(uncached, 0.95)} (n=${uncached.length}).`,
      "",
      "Sampled 100 simulated requests (one row per characteristic):",
      "",
      requestLog.slice(0, 10).join(", ") + `, ... (${requestLog.length} total; ids r001..r${String(requestLog.length).padStart(3, "0")})`,
      "",
      "Highest yes-rate characteristics:",
      "",
      "| characteristic | yes | no | uncertain/unknown |",
      "|---|---|---|---|",
      ...top.map((q) => row(q.id)),
      "",
      "Lowest yes-rate characteristics:",
      "",
      "| characteristic | yes | no | uncertain/unknown |",
      "|---|---|---|---|",
      ...bottom.map((q) => row(q.id)),
      "",
      "Verdicts: yes/no from Jev noul (>=0.7 / <=0.3); uncertain otherwise or when an answer is missing. This precomputed answer materialization is a cold-start cache for later pipeline steps, not a benchmark result.",
    ].join("\n");
    fs.writeFileSync(mdPath, md);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          kind: "jev_characteristic_precompute",
          scopeWarning:
            "Precompute of the 100-characteristic bank over a bounded pool (buildLivePool). NOT a benchmark claim and NOT full-population evidence.",
          asOf: asOf,
          mode: live ? "live_jev" : "local_mock",
          eligiblePopulation: population.length,
          poolCap,
          poolIds,
          bankSize: result.questionCount,
          chunkSize,
          maxLiveCalls,
          telemetry: {
            liveCalls: result.liveCalls,
            cacheHits: result.cacheHits,
            errors: result.errors,
            fallbackUsed: result.fallbackUsed,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd: costUsd,
            latencyUncachedMs: { p50: percentile(uncached, 0.5), p95: percentile(uncached, 0.95), n: uncached.length },
          },
          perQuestion: Object.fromEntries(counts.entries()),
          perQuestionYesRate: perQuestionYesRate.slice(0, 50),
          verdictsByConstituent: verdictMap,
        },
        null,
        2,
      ),
    );
    console.log(md);
    console.log(`Wrote ${jsonPath} and ${mdPath}. Cache: ${live ? cachePath : "(in-memory mock)"} -> ${cache.size} entries.`);
  } finally {
    db.close();
    cache.close();
  }
}

main().catch((e) => {
  console.error(`precompute-characteristics failed: ${(e as Error).message}`);
  process.exit(1);
});
