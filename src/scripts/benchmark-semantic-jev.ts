#!/usr/bin/env tsx
/**
 * Held-out semantic vs semantic+Jev comparison for GiveCampus.
 *
 * Usage:
 *   npx tsx src/scripts/benchmark-semantic-jev.ts [--db data/givecampus.sqlite]
 *     [--t0 2025-08-31] [--top 50] [--batch 100] [--concurrency 4]
 *     [--cache data/semantic-emb-cache.sqlite] [--jev-cache data/jev-live-cache.sqlite]
 *     [--out docs/results] [--model text-embedding-3-small]
 *
 * Separate held-out comparison (NOT part of src/benchmark selection):
 * - Same eligible population + outcome semantics as src/benchmark at T0.
 * - Concise as-of-safe constituent text from pre-T0 giving / interactions /
 *   events / career-recorded fields only. No future/opportunity leakage, no
 *   names/notes/titles/employers in text (banded aggregates only) and no PII
 *   in committed output (ids/scores/aggregates only).
 * - Query + all eligible profiles embedded with OpenAI text-embedding-3-small
 *   in batches; gitignored local SQLite vector cache; cosine = semantic baseline.
 * - Rerank ONLY the semantic top-K (default 50) with the existing Jev headline
 *   evaluation/client/cache; remaining order preserved -> semantic_plus_jev.
 * - Both lists evaluated on the exact same full population/outcomes.
 *
 * Reads OPENAI_API_KEY + TYPESAFE_API_KEY server-side via src/env.ts (never logs).
 * If the embedding endpoint/model fails, the script stops and reports the exact
 * error (no fallback ranking, no broadened scope).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { resolveDbPath } from "../config.js";
import { loadServerEnv } from "../env.js";
import { TypesafeJevClient } from "../givecampus/jev.js";
import {
  getAttendanceAsOf,
  getCareerAsOf,
  getInteractionsAsOf,
  getPaidGiftsAsOf,
} from "../givecampus/store.js";
import { assertSamePopulation, getEligiblePopulation } from "../benchmark/eligibility.js";
import { buildAllFeatures, loadOutcomes, loadSnapshot } from "../benchmark/features.js";
import { evaluateRanking } from "../benchmark/metrics.js";
import {
  JEV_INPUT_USD_PER_MTOK,
  JEV_LIVE_MAX_CALLS,
  JEV_LIVE_MODEL_FALLBACK,
  JEV_LIVE_MODEL_PIN,
  SqlitePoolCache,
  costInputUsd,
  fetchJevScoresForPool,
  jevScoreFromAnswers,
  type LiveCallRecord,
} from "../benchmark/jev-live.js";

const T0_DEFAULT = "2025-08-31";
const QUERY_DEFAULT = "Who should I contact before Giving Day, why now, and with what action?";
const EMB_MODEL_DEFAULT = "text-embedding-3-small";
/** Public list price for text-embedding-3-small input. */
const EMB_INPUT_USD_PER_MTOK = 0.02;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function sha16(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Gitignored local vector cache (data/*.sqlite*): key -> embedding JSON. */
class EmbCache {
  private db: Database.Database;
  hits = 0;
  misses = 0;
  constructor(cachePath: string) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    this.db = new Database(cachePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS emb_cache (key TEXT PRIMARY KEY, vec TEXT NOT NULL)`);
  }
  get(key: string): number[] | null {
    const row = this.db.prepare(`SELECT vec FROM emb_cache WHERE key = ?`).get(key) as
      | { vec: string }
      | undefined;
    if (!row) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return JSON.parse(row.vec) as number[];
  }
  set(key: string, vec: number[]): void {
    this.db.prepare(`INSERT OR REPLACE INTO emb_cache (key, vec) VALUES (?, ?)`).run(key, JSON.stringify(vec));
  }
  get size(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM emb_cache`).get() as { n: number }).n;
  }
  close(): void {
    this.db.close();
  }
}

interface EmbBatchStat {
  latencyMs: number;
  promptTokens: number;
}

async function embedBatch(model: string, apiKey: string, inputs: string[]): Promise<{ vecs: number[][]; promptTokens: number }> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: inputs, encoding_format: "float" }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(`OpenAI embeddings failed: HTTP ${res.status} model=${model} body=${body}`);
  }
  const json = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
    usage: { prompt_tokens: number };
  };
  const vecs = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return { vecs, promptTokens: json.usage?.prompt_tokens ?? 0 };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function summarizeJev(records: LiveCallRecord[]) {
  const ok = records.filter((r) => !r.error);
  const uncached = ok.filter((r) => !r.cacheHit).map((r) => r.latencyMs).sort((a, b) => a - b);
  const inputTokens = ok.reduce((s, r) => s + r.inputTokens, 0);
  const outputTokens = ok.reduce((s, r) => s + r.outputTokens, 0);
  const counts = new Map<string, number>();
  for (const r of ok) counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
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
    resolvedModel: [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown",
    modelCounts: Object.fromEntries(counts),
  };
}

function bandCount(n: number): string {
  if (n === 0) return "none";
  if (n === 1) return "1";
  if (n <= 4) return "2-4";
  return "5+";
}

async function main() {
  loadServerEnv();
  const dbPath = arg("--db", resolveDbPath())!;
  const t0 = arg("--t0", T0_DEFAULT)!;
  const topK = Number(arg("--top", "50"));
  const batchSize = Number(arg("--batch", "100"));
  const concurrency = Number(arg("--concurrency", "4"));
  const cachePath = arg("--cache", path.join("data", "semantic-emb-cache.sqlite"))!;
  const jevCachePath = arg("--jev-cache", path.join("data", "jev-live-cache.sqlite"))!;
  const outDir = arg("--out", path.join("docs", "results"))!;
  const embModel = arg("--model", EMB_MODEL_DEFAULT)!;
  const query = arg("--query", QUERY_DEFAULT)!;
  if (!Number.isInteger(topK) || topK < 1 || topK > JEV_LIVE_MAX_CALLS) throw new Error(`--top must be 1..${JEV_LIVE_MAX_CALLS}`);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("--batch must be 1..500");
  if (!fs.existsSync(dbPath)) throw new Error(`DB missing: ${dbPath}`);
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiKey) throw new Error("OPENAI_API_KEY not configured (set it in .env.local; never commit it)");
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("TYPESAFE_API_KEY not configured (set it in .env.local; never commit it)");

  const db = new Database(dbPath, { readonly: true });
  const embCache = new EmbCache(cachePath);
  const jevCache = new SqlitePoolCache(jevCachePath);
  try {
    // Same eligible population + outcome semantics as src/benchmark at T0.
    const population = getEligiblePopulation(db, t0);
    const popIds = population.map((p) => p.id);
    const snap = loadSnapshot(db, t0);
    const feats = buildAllFeatures(db, population, t0, snap);
    const { donors, amounts } = loadOutcomes(db, t0, 90);

    // Concise as-of-safe text: pre-T0 giving/interactions/events/career-recorded
    // fields only, banded aggregates. No names/notes/titles/employers, no future
    // events, no opportunities/campaigns/funds.
    const texts = new Map<number, string>();
    for (const p of population) {
      const fv = feats.get(p.id)!;
      const gifts = getPaidGiftsAsOf(db, p.id, t0).filter((g) => g.status === "paid" && g.gift_type !== "recurring_parent");
      const paidDates = gifts.map((g) => g.gift_date.slice(0, 10)).sort();
      const lastPaid = paidDates.length > 0 ? paidDates[paidDates.length - 1]! : null;
      const recency = lastPaid === null ? "never gave on record" : (() => {
        const d = Math.round((Date.parse(`${t0}T00:00:00Z`) - Date.parse(`${lastPaid}T00:00:00Z`)) / 86_400_000);
        if (d <= 30) return "last gift within 30 days";
        if (d <= 90) return "last gift within 90 days";
        if (d <= 365) return "last gift within a year";
        if (d <= 730) return "last gift 1-2 years ago";
        return "last gift over 2 years ago";
      })();
      const in5y = gifts.filter((g) => g.gift_date.slice(0, 10) > `${Number(t0.slice(0, 4)) - 5}${t0.slice(4)}`).length;
      const lifetime = gifts.reduce((s, g) => s + Number(g.amount), 0);
      const band = lifetime <= 0 ? "no lifetime total" : lifetime < 500 ? "lifetime under $500" : lifetime < 5000 ? "lifetime $500-$5k" : lifetime < 25000 ? "lifetime $5k-$25k" : "lifetime over $25k";
      const inters = getInteractionsAsOf(db, p.id, t0);
      const oneAgo = `${Number(t0.slice(0, 4)) - 1}${t0.slice(4)}`;
      const twoAgo = `${Number(t0.slice(0, 4)) - 2}${t0.slice(4)}`;
      const connected1y = inters.filter((i) => i.occurred_at.slice(0, 10) > oneAgo && ["connected", "replied", "meeting_booked", "gift_received", "pledged"].includes(i.outcome)).length;
      const overdue = inters.some((i) => i.follow_up_date !== null && i.follow_up_date.slice(0, 10) < t0 && !inters.some((j) => j.occurred_at.slice(0, 10) > i.follow_up_date!.slice(0, 10) && j.occurred_at.slice(0, 10) <= t0));
      const atts = getAttendanceAsOf(db, p.id, t0).filter((a) => a.attended_at.slice(0, 10) > twoAgo).length;
      const career = getCareerAsOf(db, p.id, t0).filter((c) => c.is_current === 1);
      const senior = career.some((c) => c.job_title !== null && /chief|officer|president|partner|founder|director|\bvp\b|vice/i.test(c.job_title));
      const employment = career.length === 0 ? "no current employment on record" : senior ? "currently employed, senior-role signal" : "currently employed";
      texts.set(p.id, [
        `Giving Day outreach profile as of ${t0}.`,
        `Giving: ${recency}; ${bandCount(in5y)} paid gifts in 5y; ${band}.`,
        `Engagement: ${bandCount(atts)} event attendances in 2y; ${bandCount(connected1y)} connected contacts in 1y; follow-up overdue: ${overdue ? "yes" : "no"}.`,
        `Career on record: ${employment}.`,
        `Why-now flag: ${fv.whyNow}.`,
      ].join(" "));
    }

    // Embed query + all eligible profiles in batches (cache first).
    const embStats: EmbBatchStat[] = [];
    let embPromptTokens = 0;
    const keyFor = (text: string) => `${embModel}:${sha16(text)}`;
    async function embedOne(text: string): Promise<number[] | null> {
      return embCache.get(keyFor(text));
    }
    const allTexts = [query, ...popIds.map((id) => texts.get(id)!)];
    const vecs = new Map<string, number[]>();
    const missing: string[] = [];
    for (const t of allTexts) {
      const v = await embedOne(t);
      if (v) vecs.set(t, v);
      else missing.push(t);
    }
    for (let i = 0; i < missing.length; i += batchSize) {
      const chunk = missing.slice(i, i + batchSize);
      let attempt = 0;
      for (;;) {
        const start = Date.now();
        try {
          const { vecs: out, promptTokens } = await embedBatch(embModel, openaiKey, chunk);
          embStats.push({ latencyMs: Date.now() - start, promptTokens });
          embPromptTokens += promptTokens;
          chunk.forEach((t, j) => {
            embCache.set(keyFor(t), out[j]!);
            vecs.set(t, out[j]!);
          });
          break;
        } catch (e) {
          attempt += 1;
          const msg = (e as Error).message;
          const retryable = /HTTP (429|500|502|503|504)/.test(msg) && attempt < 3;
          if (!retryable) throw new Error(`embedding failed (exact error): ${msg}`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
    const qVec = vecs.get(query);
    if (!qVec) throw new Error("embedding failed (exact error): query vector missing after embed loop");
    const latSorted = embStats.map((s) => s.latencyMs).sort((a, b) => a - b);
    const embTelemetry = {
      model: embModel,
      query,
      batches: embStats.length,
      profilesEmbedded: popIds.length,
      inputTokens: embPromptTokens,
      costInputUsd: Math.round((embPromptTokens / 1_000_000) * EMB_INPUT_USD_PER_MTOK * 1_000_000) / 1_000_000,
      priceUsdPerMInput: EMB_INPUT_USD_PER_MTOK,
      cacheHits: embCache.hits,
      liveInputs: embCache.misses,
      latencyBatchMs: { p50: percentile(latSorted, 0.5), p95: percentile(latSorted, 0.95), n: latSorted.length },
      cacheEntries: embCache.size,
    };

    // Semantic baseline: cosine(query, profile), score desc, id asc.
    const semScores = new Map<number, number>();
    for (const id of popIds) semScores.set(id, cosine(qVec, vecs.get(texts.get(id)!)!));
    const semanticRanked = [...popIds].sort((a, b) => {
      const d = semScores.get(b)! - semScores.get(a)!;
      return d !== 0 ? d : a - b;
    });
    const semPos = new Map(semanticRanked.map((id, i) => [id, i] as const));

    // Rerank ONLY the semantic top-K with existing Jev headline scoring.
    const headIds = semanticRanked.slice(0, topK);
    const client = new TypesafeJevClient();
    const head = await fetchJevScoresForPool({
      db, poolIds: headIds, t0, client, cache: jevCache,
      models: [JEV_LIVE_MODEL_PIN, JEV_LIVE_MODEL_FALLBACK],
      concurrency, maxLiveCalls: JEV_LIVE_MAX_CALLS,
    });
    const jevScores = new Map(head.records.filter((r) => !r.error).map((r) => [r.id, r.score] as const));
    const jevSummary = summarizeJev(head.records);
    const rerankedHead = [...headIds].sort((a, b) => {
      const ha = jevScores.has(a);
      const hb = jevScores.has(b);
      if (ha && hb) {
        const d = jevScores.get(b)! - jevScores.get(a)!;
        if (d !== 0) return d;
        return semPos.get(a)! - semPos.get(b)!;
      }
      if (ha !== hb) return ha ? -1 : 1; // failed ids sink to head tail, semantic order kept
      return semPos.get(a)! - semPos.get(b)!;
    });
    const semanticPlusJev = [...rerankedHead, ...semanticRanked.slice(topK)];
    assertSamePopulation(semanticRanked, popIds, `semantic@${t0}`);
    assertSamePopulation(semanticPlusJev, popIds, `semantic_plus_jev@${t0}`);

    const mSem = evaluateRanking(semanticRanked, donors, amounts);
    const mJev = evaluateRanking(semanticPlusJev, donors, amounts);
    const row = (m: typeof mSem) => ({
      hitsAt20: m.hitsAt20, pAt20: m.precisionAt20, ndcgAt20: m.ndcgAt20,
      hitsAt100: m.hitsAt100, pAt100: m.precisionAt100, ndcgAt100: m.ndcgAt100,
      amountTop100: m.amountTop100,
    });

    const report = {
      kind: "semantic-vs-semantic-plus-jev",
      scopeWarning:
        `HELD-OUT comparison on the FULL eligible population (N=${popIds.length}) at ${t0}. ` +
        `semantic_plus_jev reranks ONLY the semantic top-${topK} with Jev (pool cap ${topK}); positions ${topK + 1}..N keep semantic order. ` +
        "Descriptive only: single held-out cutoff, no significance testing, no winner declared.",
      t0,
      windowDays: 90,
      windowEnd: "2025-11-29",
      eligibleN: popIds.length,
      donorCount: donors.size,
      populationDefinition:
        "entity_type='individual' AND deceased=0 AND (deceased_date NULL or > T0) AND do_not_solicit=0 AND (email deliverable OR phone available); identical id set for both rankers",
      outcomeDefinition:
        "paid gifts (status='paid', gift_type != 'recurring_parent') with gift_date in (T0, T0+90d], excluding gifts after deceased_date",
      methods: {
        semantic: {
          rankerId: "semantic_cosine",
          family: "semantic",
          description: `cosine(query, profile) with ${embModel}; query=${JSON.stringify(query)}`,
          metrics: row(mSem),
        },
        semantic_plus_jev: {
          rankerId: "semantic_plus_jev",
          family: "semantic_jev",
          description: `semantic top-${topK} reranked by Jev headline score (desc, semantic-pos tiebreak; Jev failures sink to head tail in semantic order); tail ${topK + 1}..N unchanged`,
          metrics: row(mJev),
        },
      },
      embedding: embTelemetry,
      jev: {
        questions: "headline-6 (contract)",
        rerankDepth: topK,
        requestedModel: JEV_LIVE_MODEL_PIN,
        resolvedModel: jevSummary.resolvedModel,
        modelCounts: jevSummary.modelCounts,
        fallbackUsed: head.fallbackUsed,
        headline: { ...jevSummary, priceUsdPerMInput: JEV_INPUT_USD_PER_MTOK, outputFree: true },
        errors: head.records.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
      },
      rankedTop200: {
        semantic_cosine: semanticRanked.slice(0, 200),
        semantic_plus_jev: semanticPlusJev.slice(0, 200),
      },
      perIdJevHead: headIds.map((id) => ({
        id,
        semanticPos: semPos.get(id)!,
        rerankedPos: rerankedHead.indexOf(id),
        jev: jevScores.has(id) ? Math.round(jevScores.get(id)! * 10000) / 10000 : null,
      })),
    };

    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, `semantic-jev-${t0}.json`);
    const mdPath = path.join(outDir, `semantic-jev-${t0}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    const L: string[] = [];
    L.push(`# Semantic vs semantic+Jev @ ${t0} (full population N=${popIds.length}, donors=${donors.size})`);
    L.push("");
    L.push(`> Held-out comparison on the exact same population/outcomes as the benchmark held-out (${t0} -> 2025-11-29). semantic_plus_jev reranks ONLY the semantic top-${topK} with Jev headline scoring; positions ${topK + 1}..N keep semantic order. Descriptive only: single cutoff, no significance testing, no winner declared.`);
    L.push("");
    L.push(`Query: ${JSON.stringify(query)} (embedded with ${embModel}). Profiles: concise as-of-safe banded text from pre-T0 giving/interactions/events/career-recorded fields only; no future/opportunity leakage, no PII in output.`);
    L.push("");
    L.push(`Embedding: model ${embModel}, ${embTelemetry.batches} live batches, input tokens ${embTelemetry.inputTokens}, cost $${embTelemetry.costInputUsd.toFixed(6)} @ $${EMB_INPUT_USD_PER_MTOK}/M input. Cache hits ${embTelemetry.cacheHits}, live inputs ${embTelemetry.liveInputs}. Batch latency p50/p95 ${embTelemetry.latencyBatchMs.p50}/${embTelemetry.latencyBatchMs.p95}ms.`);
    L.push(`Jev rerank (top-${topK}): requested ${JEV_LIVE_MODEL_PIN}, resolved ${jevSummary.resolvedModel}${head.fallbackUsed ? " (fallback used)" : ""}. Live calls ${jevSummary.liveCalls}, cache hits ${jevSummary.cacheHits}, errors ${jevSummary.errors}, input tokens ${jevSummary.inputTokens}, cost $${jevSummary.costInputUsd.toFixed(6)} @ $${JEV_INPUT_USD_PER_MTOK}/M input (output free). Uncached latency p50/p95 ${jevSummary.latencyUncachedMs.p50}/${jevSummary.latencyUncachedMs.p95}ms.`);
    L.push("");
    L.push(`| ranker | hits@20 | P@20 | NDCG@20 | hits@100 | P@100 | NDCG@100 | paid$ top100 (descr) |`);
    L.push(`|---|---|---|---|---|---|---|---|`);
    for (const m of [report.methods.semantic, report.methods.semantic_plus_jev]) {
      const v = m.metrics;
      L.push(`| ${m.rankerId} | ${v.hitsAt20} | ${v.pAt20.toFixed(4)} | ${v.ndcgAt20.toFixed(4)} | ${v.hitsAt100} | ${v.pAt100.toFixed(4)} | ${v.ndcgAt100.toFixed(4)} | ${v.amountTop100.toFixed(2)} |`);
    }
    L.push("");
    L.push(`Limits: rerank pool cap ${topK} (Jev never sees positions ${topK + 1}..N); paid$ descriptive only; scores are ordinal ranks, not probabilities.`);
    L.push("");
    const md = L.join("\n");
    fs.writeFileSync(mdPath, md);
    console.log(md);
    console.log(`Wrote ${jsonPath} and ${mdPath} (emb cache: ${cachePath}, entries: ${embCache.size}; jev cache: ${jevCachePath}, entries: ${jevCache.size})`);
  } finally {
    embCache.close();
    jevCache.close();
    db.close();
  }
}

main().catch((e) => {
  console.error(`benchmark-semantic-jev failed: ${(e as Error).message}`);
  process.exit(1);
});
