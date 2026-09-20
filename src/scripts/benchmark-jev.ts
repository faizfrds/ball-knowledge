#!/usr/bin/env tsx
/**
 * Live Jev reranker-pool benchmark.
 *
 * Usage:
 *   npx tsx src/scripts/benchmark-jev.ts [--db data/givecampus.sqlite]
 *     [--t0 2025-08-31] [--train 2023-08-31] [--per-ranker 50] [--cap 150]
 *     [--concurrency 4] [--cache data/jev-live-cache.sqlite]
 *     [--out docs/results] [--model jev-1.13.0] [--ablation 40]
 *
 * Reads TYPESAFE_API_KEY server-side via src/env.ts (never logs it).
 * Pinned model first; on model rejection falls back to jev-latest and records
 * the echoed model. Cache file default is gitignored (`data/*.sqlite*`).
 * Outputs sanitized JSON + Markdown (ids/scores/aggregates only).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { resolveDbPath } from "../config.js";
import { loadServerEnv } from "../env.js";
import { TypesafeJevClient } from "../givecampus/jev.js";
import {
  GENERIC_QUESTIONS,
  JEV_ABLATION_MAX_CALLS,
  JEV_INPUT_USD_PER_MTOK,
  JEV_LIVE_MAX_CALLS,
  JEV_LIVE_MODEL_FALLBACK,
  JEV_LIVE_MODEL_PIN,
  JEV_LIVE_T0,
  JEV_LIVE_TRAIN_T0,
  POOL_CAP,
  POOL_PER_RANKER,
  buildLivePool,
  costInputUsd,
  evaluatePool,
  fetchJevScoresForPool,
  genericQuestionsHash,
  genericScoreFromAnswers,
  rankPoolComparators,
  rankScores,
  SqlitePoolCache,
  type LiveCallRecord,
} from "../benchmark/jev-live.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

function summarizeCalls(records: LiveCallRecord[]) {
  const ok = records.filter((r) => !r.error);
  const uncached = ok.filter((r) => !r.cacheHit).map((r) => r.latencyMs).sort((a, b) => a - b);
  const inputTokens = ok.reduce((s, r) => s + r.inputTokens, 0);
  const outputTokens = ok.reduce((s, r) => s + r.outputTokens, 0);
  const counts = new Map<string, number>();
  for (const r of ok) counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
  const resolvedModel = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  const actions = new Map<string, number>();
  for (const r of ok) if (r.finalAction) actions.set(r.finalAction, (actions.get(r.finalAction) ?? 0) + 1);
  return {
    n: records.length,
    ok: ok.length,
    errors: records.length - ok.length,
    cacheHits: ok.filter((r) => r.cacheHit).length,
    liveCalls: ok.filter((r) => !r.cacheHit).length,
    inputTokens,
    outputTokens,
    costInputUsd: costInputUsd(inputTokens),
    latencyUncachedMs: { p50: percentile(uncached, 0.5), p95: percentile(uncached, 0.95), n: uncached.length },
    resolvedModel,
    modelCounts: Object.fromEntries(counts),
    finalActions: Object.fromEntries(actions),
    gateOverrides: ok.filter((r) => r.gateOverride).length,
  };
}

async function main() {
  loadServerEnv();
  const dbPath = arg("--db", resolveDbPath())!;
  const t0 = arg("--t0", JEV_LIVE_T0)!;
  const trainT0 = arg("--train", JEV_LIVE_TRAIN_T0)!;
  const perRanker = Number(arg("--per-ranker", String(POOL_PER_RANKER)));
  const cap = Number(arg("--cap", String(POOL_CAP)));
  const concurrency = Number(arg("--concurrency", "4"));
  const cachePath = arg("--cache", path.join("data", "jev-live-cache.sqlite"))!;
  const outDir = arg("--out", path.join("docs", "results"))!;
  const pinModel = arg("--model", JEV_LIVE_MODEL_PIN)!;
  const ablationN = Number(arg("--ablation", "40"));
  if (!Number.isInteger(perRanker) || perRanker < 1 || perRanker > 100) throw new Error("per-ranker must be 1..100");
  if (!Number.isInteger(cap) || cap < 1 || cap > JEV_LIVE_MAX_CALLS) throw new Error(`cap must be 1..${JEV_LIVE_MAX_CALLS}`);
  if (!fs.existsSync(dbPath)) throw new Error(`DB missing: ${dbPath}`);
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new Error("TYPESAFE_API_KEY not configured (set it in .env.local; never commit it)");
  }

  const db = new Database(dbPath, { readonly: true });
  const cache = new SqlitePoolCache(cachePath);
  try {
    const pool = buildLivePool(db, t0, { perRanker, cap, trainT0 });
    const client = new TypesafeJevClient();
    const models = pinModel === JEV_LIVE_MODEL_FALLBACK ? [JEV_LIVE_MODEL_FALLBACK] : [pinModel, JEV_LIVE_MODEL_FALLBACK];

    const head = await fetchJevScoresForPool({
      db, poolIds: pool.poolIds, t0, client, cache, models, concurrency, maxLiveCalls: JEV_LIVE_MAX_CALLS,
    });
    const headScores = new Map(head.records.filter((r) => !r.error).map((r) => [r.id, r.score] as const));
    // Failed ids fall back to deterministic id-asc tail (documented, keeps same-population eval).
    for (const id of pool.poolIds) if (!headScores.has(id)) headScores.set(id, -1 + 1 / (1 + id));
    const headRanked = rankScores(headScores, pool.poolIds);
    const headSummary = summarizeCalls(head.records);

    let ablation: { ranked: number[]; summary: ReturnType<typeof summarizeCalls>; n: number } | null = null;
    let ablationOmitted: string | null = null;
    const ablN = Math.max(0, Math.min(JEV_ABLATION_MAX_CALLS, ablationN));
    if (ablN === 0) {
      ablationOmitted = "disabled via --ablation 0";
    } else {
      const ablIds = [...pool.poolIds].sort((a, b) => a - b).slice(0, ablN);
      try {
        const abl = await fetchJevScoresForPool({
          db, poolIds: ablIds, t0, client, cache, models, concurrency,
          questions: GENERIC_QUESTIONS, scorer: genericScoreFromAnswers,
          maxLiveCalls: JEV_ABLATION_MAX_CALLS,
        });
        const okN = abl.records.filter((r) => !r.error).length;
        if (okN < Math.max(1, Math.floor(ablIds.length / 2))) {
          ablationOmitted = `generic ablation had ${abl.records.length - okN}/${ablIds.length} errors; omitted to avoid a noisy partial read`;
        } else {
          const scores = new Map(abl.records.filter((r) => !r.error).map((r) => [r.id, r.score] as const));
          // Ablation ranks its own subset; for the shared-pool table it is
          // scored on pool order induced by its subset ranking + id-asc tail.
          const sub = rankScores(scores, ablIds);
          const pos = new Map(sub.map((id, i) => [id, i] as const));
          const ranked = [...pool.poolIds].sort((a, b) => {
            const pa = pos.has(a) ? pos.get(a)! : 1e9;
            const pb = pos.has(b) ? pos.get(b)! : 1e9;
            return pa !== pb ? pa - pb : a - b;
          });
          ablation = { ranked, summary: summarizeCalls(abl.records), n: ablIds.length };
        }
      } catch (e) {
        ablationOmitted = `generic ablation failed: ${(e as Error).message}`;
      }
    }

    const comparators = rankPoolComparators(db, pool.poolIds, t0, trainT0);
    const lists = [
      ...comparators,
      { rankerId: "jev_headline_rerank", family: "jev_live", ranked: headRanked, runtimeMs: 0 },
      ...(ablation ? [{ rankerId: "jev_generic_ablation", family: "jev_live", ranked: ablation.ranked, runtimeMs: 0 }] : []),
    ];
    const { rows, poolDonors, poolN } = evaluatePool(db, lists, pool.poolIds, t0);

    const report = {
      kind: "jev-live-reranker-pool",
      scopeWarning:
        "RERANKER-POOL evaluation on a fixed candidate pool (<=150). NOT a full-population result; do not compare numerically with docs/BENCHMARK.md leaderboard.",
      pool: {
        t0, trainT0, perRanker, cap,
        sources: pool.sources,
        sourceRankers: ["trained_lr_lr_f (DEV-selected LR)", "rfm_r_heavy (DEV-best RFM)", "priority_recency_heavy (DEV-selected priority)"],
        poolIds: pool.poolIds,
        poolN, poolDonors,
        windowDays: 90,
        outcome: "paid gifts (status='paid', gift_type != 'recurring_parent') with gift_date in (T0, T0+90d]",
      },
      jev: {
        questions: "headline-6 (contract) + generic-3 ablation",
        genericQuestionsHash: genericQuestionsHash(),
        requestedModel: pinModel,
        resolvedModel: headSummary.resolvedModel,
        modelCounts: headSummary.modelCounts,
        fallbackUsed: head.fallbackUsed,
        headline: { ...headSummary, priceUsdPerMInput: JEV_INPUT_USD_PER_MTOK, outputFree: true },
        ablation: ablation
          ? { subsetN: ablation.n, subset: "first-N pool ids ascending", ...ablation.summary }
          : { omitted: ablationOmitted },
        errors: head.records.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
      },
      results: rows.map((r) => ({
        rankerId: r.rankerId,
        family: r.family,
        pAt20: r.metrics.precisionAt20,
        pAt100: r.metrics.precisionAt100,
        ndcgAt20: r.metrics.ndcgAt20,
        ndcgAt100: r.metrics.ndcgAt100,
        hitsAt20: r.metrics.hitsAt20,
        hitsAt100: r.metrics.hitsAt100,
        amountTop100: r.metrics.amountTop100,
        runtimeMs: r.runtimeMs,
      })),
      perIdScores: pool.poolIds.map((id) => ({ id, jev_headline: Math.round((headScores.get(id) ?? 0) * 10000) / 10000 })),
    };

    fs.mkdirSync(outDir, { recursive: true });
    const stamp = t0;
    const jsonPath = path.join(outDir, `jev-live-${stamp}.json`);
    const mdPath = path.join(outDir, `jev-live-${stamp}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    const lines: string[] = [];
    lines.push(`# Jev live reranker-pool @ ${t0} (pool N=${poolN}, donors=${poolDonors})`);
    lines.push("");
    lines.push(`> RERANKER-POOL evaluation, not a full-population result. Fixed pool = union of top-${perRanker} from trained_lr_lr_f + rfm_r_heavy + priority_recency_heavy at held-out ${t0} (cap ${cap}). All rankers evaluated on the same pool ids + outcomes.`);
    lines.push("");
    lines.push(`Jev model: requested ${pinModel}, resolved ${headSummary.resolvedModel}${head.fallbackUsed ? " (fallback used)" : ""}. Live calls ${headSummary.liveCalls}, cache hits ${headSummary.cacheHits}, input tokens ${headSummary.inputTokens}, cost $${headSummary.costInputUsd.toFixed(6)} @ $${JEV_INPUT_USD_PER_MTOK}/M input (output free). Uncached latency p50/p95 ${headSummary.latencyUncachedMs.p50}/${headSummary.latencyUncachedMs.p95}ms.`);
    lines.push(ablation ? `Ablation: generic questions on first-${ablation.n} pool ids; resolved ${ablation.summary.resolvedModel}, live ${ablation.summary.liveCalls}, cache ${ablation.summary.cacheHits}.` : `Ablation omitted: ${ablationOmitted}.`);
    lines.push("");
    lines.push(`| ranker | P@20 | P@100 | NDCG@20 | NDCG@100 | hits@20 | hits@100 |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const r of rows) {
      const m = r.metrics;
      lines.push(`| ${r.rankerId} | ${m.precisionAt20.toFixed(4)} | ${m.precisionAt100.toFixed(4)} | ${m.ndcgAt20.toFixed(4)} | ${m.ndcgAt100.toFixed(4)} | ${m.hitsAt20} | ${m.hitsAt100} |`);
    }
    lines.push("");
    const md = lines.join("\n");
    fs.writeFileSync(mdPath, md);
    console.log(md);
    console.log(`Wrote ${jsonPath} and ${mdPath} (cache: ${cachePath}, entries: ${cache.size})`);
  } finally {
    cache.close();
    db.close();
  }
}

main().catch((e) => {
  console.error(`benchmark-jev failed: ${(e as Error).message}`);
  process.exit(1);
});
