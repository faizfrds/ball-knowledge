/**
 * Live, database-backed Jev reranker-pool evaluation slice.
 *
 * Scope (explicit): this is a RERANKER-POOL evaluation, NOT a full-14k
 * population result. A fixed candidate pool (union of top-N from the
 * DEV-selected LR, DEV-best RFM, and DEV-selected priority index at held-out
 * T0) is scored live via the server-side TypesafeJevClient; Jev-enhanced
 * ordering and every offline comparator are then evaluated on the EXACT SAME
 * pool ids + outcomes (donors/amounts intersected with the pool).
 * Pool metrics (P@20/P@100/NDCG@20/100) describe ranking inside the pool only
 * and must never be compared numerically with full-population benchmark
 * numbers in docs/BENCHMARK.md.
 *
 * Boundaries: benchmark-only. Never edits engine/server/UI/package/ingestion.
 * Reads the SQLite DB read-only plus read-only store getters for as-of-safe
 * Jev state. Secrets stay server-side (TYPESAFE_API_KEY via src/env.ts);
 * outputs are sanitized (ids + scores + aggregates only, never key/cache/PII).
 */
import fs from "node:fs";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import type Database from "better-sqlite3";
import { DATASET_VERSION } from "../config.js";
import { EVIDENCE_VERSION, makeCacheKey, sha256Hex, stableStringify } from "../givecampus/criterion.js";
import {
  HEADLINE_QUESTIONS,
  JEV_MODEL,
  evaluateWithJev,
  minus12mo,
  type JevAnswer,
  type JevCallResult,
  type JevClient,
  type JevQuestion,
  type JevState,
} from "../givecampus/jev.js";
import {
  getActivities,
  getAttendanceAsOf,
  getCareerAsOf,
  getInteractionsAsOf,
  getPaidGiftsAsOf,
} from "../givecampus/store.js";
import { buildFixedRankers, rank, type Ranker } from "./algorithms.js";
import { getEligiblePopulation } from "./eligibility.js";
import { buildAllFeatures, loadOutcomes, loadSnapshot, type FeatureVector } from "./features.js";
import { evaluateRanking, type AlgorithmMetrics } from "./metrics.js";
import { LR_GRID, lrRanker, trainLogistic, type LRModel } from "./model.js";

export const JEV_LIVE_T0 = "2025-08-31";
export const JEV_LIVE_TRAIN_T0 = "2023-08-31";
export const JEV_LIVE_MODEL_PIN = JEV_MODEL; // "jev-1.13.0"
export const JEV_LIVE_MODEL_FALLBACK = "jev-latest";
/** $42/Btok input == $0.042/Mtok input; output tokens are free. */
export const JEV_INPUT_USD_PER_MTOK = 0.042;
export const JEV_LIVE_MAX_CALLS = 150;
export const JEV_ABLATION_MAX_CALLS = 50;
/** Fixed pool recipe: top-N per source ranker at held-out T0, union, id-asc, cap. */
export const POOL_SOURCE_RANKERS = ["trained_lr_lr_f", "rfm_r_heavy", "priority_recency_heavy"] as const;
export const POOL_PER_RANKER = 50;
export const POOL_CAP = 150;

/**
 * Generic-question ablation set: deliberately plain wording with NO backtick
 * field paths and no 12-month arithmetic, to test how much the headline
 * contract's precise instructions matter. Same state shape, different lens.
 */
export const GENERIC_QUESTIONS: Record<string, JevQuestion> = {
  general_engagement: {
    type: "score",
    instructions: "How engaged does this person seem based on the information provided?",
    criteria: ["Not engaged", "Slightly engaged", "Quite engaged", "Very engaged"],
  },
  general_capacity: {
    type: "score",
    instructions: "How strong does this person's giving capacity look based on the information provided?",
    criteria: ["No capacity", "Low capacity", "Medium capacity", "High capacity"],
  },
  suggested_action: {
    type: "choice",
    instructions: "Which outreach action seems most appropriate for this person?",
    criteria: {
      broad_invite: "A light general invitation seems fine",
      hold_for_review: "Unsure — hold for human review",
      personal_outreach: "Direct personal outreach seems right",
      stewardship_thank_you: "A thank-you message seems right",
    },
  },
};

export function genericQuestionsHash(): string {
  return sha256Hex(stableStringify(GENERIC_QUESTIONS)).slice(0, 16);
}

/** True when the error looks like a pinned-model rejection (caller should try jev-latest). */
export function isModelRejection(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  return (
    /model_not_found|unknown model|invalid model|model .* not (found|available|supported)/i.test(msg) ||
    (/422/.test(msg) && /model/i.test(msg)) ||
    (/400/.test(msg) && /model/i.test(msg))
  );
}

export function costInputUsd(inputTokens: number): number {
  return Math.round((inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MTOK * 1_000_000) / 1_000_000;
}

function addYears(asOf: string, years: number): string {
  const d = new Date(Date.parse(`${asOf}T00:00:00Z`));
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function noulOf(answers: Record<string, JevAnswer>, id: string): number | null {
  const a = answers[id] as { noul?: unknown } | undefined;
  const v = a?.noul;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function scoreOf(answers: Record<string, JevAnswer>, id: string, levels = 4): number | null {
  const a = answers[id] as { score?: unknown } | undefined;
  const v = a?.score;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v / (levels - 1)));
}

/**
 * Headline Jev score: renormalized weighted sum over KNOWN criteria only
 * (unknown contributes null, weights renormalize — never imputed as 0).
 * Weights are versioned with this module (weight edit = rerank only).
 */
export function jevScoreFromAnswers(answers: Record<string, JevAnswer>): { score: number; known: number } {
  const parts: { v: number | null; w: number }[] = [
    { v: scoreOf(answers, "engagement_level"), w: 0.35 },
    { v: scoreOf(answers, "capacity_evidence_strength"), w: 0.35 },
    { v: noulOf(answers, "has_recent_gift"), w: 0.15 },
    { v: noulOf(answers, "has_repeat_giving"), w: 0.15 },
  ];
  let num = 0;
  let den = 0;
  let known = 0;
  for (const p of parts) {
    if (p.v === null) continue;
    num += p.w * p.v;
    den += p.w;
    known += 1;
  }
  return { score: den > 0 ? num / den : 0, known };
}

export function genericScoreFromAnswers(answers: Record<string, JevAnswer>): { score: number; known: number } {
  const parts: { v: number | null; w: number }[] = [
    { v: scoreOf(answers, "general_engagement"), w: 0.5 },
    { v: scoreOf(answers, "general_capacity"), w: 0.5 },
  ];
  let num = 0;
  let den = 0;
  let known = 0;
  for (const p of parts) {
    if (p.v === null) continue;
    num += p.w * p.v;
    den += p.w;
    known += 1;
  }
  return { score: den > 0 ? num / den : 0, known };
}

export function rankScores(scores: Map<number, number>, poolIds: number[]): number[] {
  return [...poolIds].sort((a, b) => {
    const d = (scores.get(b) ?? -1) - (scores.get(a) ?? -1);
    if (d !== 0) return d;
    return a - b;
  });
}

/** Train all LR grid models once on the TRAIN cutoff (benchmark protocol). */
export function trainLrModels(
  db: Database.Database,
  trainT0: string = JEV_LIVE_TRAIN_T0,
): Map<string, LRModel> {
  const trainPop = getEligiblePopulation(db, trainT0);
  const snap = loadSnapshot(db, trainT0);
  const feats = buildAllFeatures(db, trainPop, trainT0, snap);
  const out = loadOutcomes(db, trainT0, 90);
  const labels = new Map<number, number>();
  for (const p of trainPop) labels.set(p.id, out.donors.has(p.id) ? 1 : 0);
  const arr: FeatureVector[] = [...feats.values()];
  const models = new Map<string, LRModel>();
  for (const hp of LR_GRID) {
    const fit = trainLogistic(arr, labels, hp);
    models.set(hp.id, { hyperId: hp.id, ...fit });
  }
  return models;
}

function allComparators(models: Map<string, LRModel>): Ranker[] {
  const fixed = buildFixedRankers();
  const lr: Ranker[] = LR_GRID.map((hp) => lrRanker(models.get(hp.id)!, hp.id));
  return [...fixed, ...lr];
}

export interface LivePool {
  t0: string;
  trainT0: string;
  perRanker: number;
  cap: number;
  sources: Record<string, number[]>;
  poolIds: number[];
}

/**
 * Fixed, deterministic candidate pool: full-population ranking per source
 * ranker at held-out T0, top `perRanker` each, union, id-asc sorted, cap.
 */
export function buildLivePool(
  db: Database.Database,
  t0: string = JEV_LIVE_T0,
  opts: { perRanker?: number; cap?: number; trainT0?: string } = {},
): LivePool {
  const perRanker = opts.perRanker ?? POOL_PER_RANKER;
  const cap = opts.cap ?? POOL_CAP;
  const trainT0 = opts.trainT0 ?? JEV_LIVE_TRAIN_T0;
  const population = getEligiblePopulation(db, t0);
  const popIds = population.map((p) => p.id);
  const snap = loadSnapshot(db, t0);
  const feats = buildAllFeatures(db, population, t0, snap);
  const models = trainLrModels(db, trainT0);
  const rankers = allComparators(models);
  const byId = new Map(rankers.map((r) => [r.id, r]));
  const sources: Record<string, number[]> = {};
  const union = new Set<number>();
  for (const id of POOL_SOURCE_RANKERS) {
    const r = byId.get(id);
    if (!r) throw new Error(`Pool source ranker missing: ${id}`);
    const top = rank(r, feats, popIds).slice(0, perRanker);
    sources[id] = top;
    for (const cid of top) union.add(cid);
  }
  const poolIds = [...union].sort((a, b) => a - b).slice(0, cap);
  return { t0, trainT0, perRanker, cap, sources, poolIds };
}

/** Rank every offline comparator restricted to the pool (full-pop order preserved). */
export function rankPoolComparators(
  db: Database.Database,
  poolIds: number[],
  t0: string = JEV_LIVE_T0,
  trainT0: string = JEV_LIVE_TRAIN_T0,
): { rankerId: string; family: string; ranked: number[]; runtimeMs: number }[] {
  const population = getEligiblePopulation(db, t0);
  const popIds = population.map((p) => p.id);
  const snap = loadSnapshot(db, t0);
  const feats = buildAllFeatures(db, population, t0, snap);
  const models = trainLrModels(db, trainT0);
  const pool = new Set(poolIds);
  return allComparators(models).map((r) => {
    const s = Date.now();
    const full = rank(r, feats, popIds);
    const ranked = full.filter((id) => pool.has(id));
    if (ranked.length !== poolIds.length) throw new Error(`Pool restriction dropped ids for ${r.id}`);
    return { rankerId: r.id, family: r.family, ranked, runtimeMs: Date.now() - s };
  });
}

/** As-of-safe Jev state for one constituent (mirrors worklist.buildJevState inputs). */
export function buildJevStateForId(db: Database.Database, id: number, t0: string): JevState {
  const row = db
    .prepare(`SELECT id, do_not_solicit FROM constituents WHERE id = ?`)
    .get(id) as { id: number; do_not_solicit: number } | undefined;
  if (!row) throw new Error(`Constituent not found: ${id}`);
  const gifts = getPaidGiftsAsOf(db, id, t0).filter((g) => g.status === "paid" && g.gift_type !== "recurring_parent");
  const cutoff2y = addYears(t0, -2);
  const gifts24 = gifts.filter((g) => g.gift_date.slice(0, 10) > cutoff2y);
  const sorted24 = [...gifts24].sort((a, b) => (a.gift_date < b.gift_date ? -1 : 1));
  const last = sorted24.length > 0 ? sorted24[sorted24.length - 1]! : null;
  const lifetime = gifts.reduce((s, g) => s + Number(g.amount), 0);
  const inters = getInteractionsAsOf(db, id, t0);
  const att = getAttendanceAsOf(db, id, t0);
  const career = getCareerAsOf(db, id, t0);
  const current = career.filter((c) => c.is_current === 1);
  const title = current.length > 0 ? (current[current.length - 1]!.job_title ?? null) : null;
  const employer = current.length > 0 ? (current[current.length - 1]!.employer ?? null) : null;
  const events = [
    ...inters.slice(-6).map((i) => `${i.purpose}:${i.outcome} ${i.occurred_at.slice(0, 10)}`),
    ...att.slice(-4).map((a) => `attended event ${a.event_id}`),
  ].slice(0, 12);
  const suppressed = row.do_not_solicit === 1;
  void getActivities(db, id);
  return {
    constituent_id: String(id),
    dataset_version: DATASET_VERSION,
    evidence_version: EVIDENCE_VERSION,
    as_of_date: t0,
    as_of_date_minus_12mo: minus12mo(t0),
    permissions: {
      do_not_contact: suppressed,
      do_not_solicit: suppressed,
      eligible_for_solicitation: !suppressed,
    },
    recorded_giving: {
      last_gift_date: last ? last.gift_date.slice(0, 10) : null,
      last_gift_amount: last ? Number(last.amount) : null,
      lifetime_total: gifts.length > 0 ? Math.round(lifetime * 100) / 100 : null,
      gift_count_24mo: gifts24.length,
    },
    engagement: { events },
    explicit_capacity: { rating: null, source: null },
    context: { title, employer },
  };
}

/** Minimal cache surface: file-backed sqlite in prod, Map-backed in tests. */
export interface PoolCache {
  get(key: string): { hit: true; value: JevCallResult } | { hit: false };
  set(key: string, value: JevCallResult): void;
  readonly size: number;
}

export class MapPoolCache implements PoolCache {
  private map = new Map<string, JevCallResult>();
  get(key: string) {
    const v = this.map.get(key);
    return v ? { hit: true as const, value: v } : { hit: false as const };
  }
  set(key: string, value: JevCallResult) {
    this.map.set(key, value);
  }
  get size() {
    return this.map.size;
  }
}

/**
 * SQLite KV file cache. Default path `data/jev-live-cache.sqlite` is
 * gitignored (`data/*.sqlite*` + `*.sqlite`), so live answers never commit.
 */
export class SqlitePoolCache implements PoolCache {
  private db: Database.Database;
  constructor(cachePath = "data/jev-live-cache.sqlite") {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    this.db = new DatabaseConstructor(cachePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS jev_live_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }
  get(key: string) {
    const row = this.db.prepare(`SELECT value FROM jev_live_cache WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (!row) return { hit: false as const };
    return { hit: true as const, value: JSON.parse(row.value) as JevCallResult };
  }
  set(key: string, value: JevCallResult) {
    this.db.prepare(`INSERT OR REPLACE INTO jev_live_cache (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
  }
  get size() {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM jev_live_cache`).get() as { n: number }).n;
  }
  close() {
    this.db.close();
  }
}

export interface LiveCallRecord {
  id: number;
  score: number;
  knownCriteria: number;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  cacheHit: boolean;
  finalAction?: string;
  gateOverride?: boolean;
  error?: string;
}

function cacheKeyFor(state: JevState, questions: Record<string, JevQuestion>, model: string): string {
  const qHash = sha256Hex(stableStringify(questions)).slice(0, 16);
  return makeCacheKey({
    datasetVersion: state.dataset_version,
    evidenceVersion: state.evidence_version,
    asOf: state.as_of_date,
    stateHash: sha256Hex(stableStringify(state)).slice(0, 16),
    questionsHash: qHash,
    model,
  });
}

/**
 * Live-score one pool: per-id Jev state -> cache -> client.systemOne with
 * pinned model then jev-latest fallback on model rejection. Concurrency
 * limited (default 4) with a small stagger to stay rate-safe. Total UNIQUE
 * live calls must stay <= `maxLiveCalls` (cache hits are free).
 */
export async function fetchJevScoresForPool(args: {
  db: Database.Database;
  poolIds: number[];
  t0: string;
  client: JevClient;
  cache: PoolCache;
  models?: string[];
  concurrency?: number;
  questions?: Record<string, JevQuestion>;
  scorer?: (answers: Record<string, JevAnswer>) => { score: number; known: number };
  maxLiveCalls?: number;
}): Promise<{ records: LiveCallRecord[]; liveCalls: number; cacheHits: number; fallbackUsed: boolean }> {
  const models = args.models ?? [JEV_LIVE_MODEL_PIN, JEV_LIVE_MODEL_FALLBACK];
  const concurrency = Math.max(1, Math.min(8, args.concurrency ?? 4));
  const questions = args.questions ?? HEADLINE_QUESTIONS;
  const scorer = args.scorer ?? jevScoreFromAnswers;
  const maxLiveCalls = args.maxLiveCalls ?? JEV_LIVE_MAX_CALLS;
  const queue = [...args.poolIds].sort((a, b) => a - b);
  const records = new Map<number, LiveCallRecord>();
  let liveCalls = 0;
  let cacheHits = 0;
  let fallbackUsed = false;
  let started = 0;

  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      const state = buildJevStateForId(args.db, id, args.t0);
      const eligible = state.permissions.eligible_for_solicitation;
      // Try pinned model cache first so a fallback model never collides.
      let done = false;
      for (const [mi, model] of models.entries()) {
        if (done) break;
        const key = cacheKeyFor(state, questions, model);
        const cached = args.cache.get(key);
        if (cached.hit) {
          const r = cached.value;
          const { score, known } = scorer(r.answers);
          const picked = (r.answers.permitted_action ?? r.answers.suggested_action) as
            | { choice?: string }
            | undefined;
          const choice = picked?.choice;
          const gateOverride = Boolean(choice && choice !== "hold_for_review" && !eligible);
          records.set(id, {
            id, score, knownCriteria: known, model: r.model,
            latencyMs: r.latencyMs, inputTokens: r.usage.input_tokens,
            outputTokens: r.usage.output_tokens, retries: r.retries,
            cacheHit: true,
            finalAction: gateOverride ? "hold_for_review" : choice,
            gateOverride: gateOverride || undefined,
          });
          cacheHits += 1;
          if (mi > 0) fallbackUsed = true;
          done = true;
          break;
        }
        if (liveCalls >= maxLiveCalls) {
          records.set(id, {
            id, score: 0, knownCriteria: 0, model, latencyMs: 0,
            inputTokens: 0, outputTokens: 0, retries: 0, cacheHit: false,
            error: "call_budget_exhausted",
          });
          done = true;
          break;
        }
        const t0ms = Date.now();
        try {
          const out = await evaluateWithJev(state, {
            client: args.client,
            eligibleForSolicitation: eligible,
            datasetVersion: state.dataset_version,
            evidenceVersion: state.evidence_version,
            model,
          });
          if (!out.available || !out.result) throw new Error(out.reason ?? "jev_unavailable");
          if (out.result.model !== model) fallbackUsed = true;
          // Mirror the call into the pool cache (evaluateWithJev used its own
          // memory cache only when passed; persist here under the full key).
          args.cache.set(key, { ...out.result, cacheHit: false });
          liveCalls += 1;
          const { score, known } = scorer(out.result.answers);
          records.set(id, {
            id, score, knownCriteria: known, model: out.result.model,
            latencyMs: out.result.latencyMs, inputTokens: out.result.usage.input_tokens,
            outputTokens: out.result.usage.output_tokens, retries: out.result.retries,
            cacheHit: false, finalAction: out.finalAction, gateOverride: out.gateOverride,
          });
          void t0ms;
          done = true;
        } catch (e) {
          if (isModelRejection(e) && mi < models.length - 1) {
            fallbackUsed = true;
            continue; // try next model for the same id
          }
          records.set(id, {
            id, score: 0, knownCriteria: 0, model, latencyMs: Date.now() - t0ms,
            inputTokens: 0, outputTokens: 0, retries: 0, cacheHit: false,
            error: (e as Error).message ?? "jev_error",
          });
          done = true;
        }
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    if (started < queue.length && i > 0) await new Promise((r) => setTimeout(r, 100));
    started += 1;
    workers.push(worker());
  }
  await Promise.all(workers);
  return {
    records: args.poolIds.map((id) => records.get(id)!),
    liveCalls,
    cacheHits,
    fallbackUsed,
  };
}

export interface PoolEvalRow {
  rankerId: string;
  family: string;
  metrics: AlgorithmMetrics;
  runtimeMs: number;
}

/** Evaluate ranked id lists on pool-restricted donors/amounts (same pool, same outcomes). */
export function evaluatePool(
  db: Database.Database,
  rankedLists: { rankerId: string; family: string; ranked: number[]; runtimeMs: number }[],
  poolIds: number[],
  t0: string,
): { rows: PoolEvalRow[]; poolDonors: number; poolN: number } {
  const { donors, amounts } = loadOutcomes(db, t0, 90);
  const pool = new Set(poolIds);
  const poolDonors = new Set([...donors].filter((id) => pool.has(id)));
  const poolAmounts = new Map([...amounts].filter(([id]) => pool.has(id)));
  const rows = rankedLists.map((r) => ({
    rankerId: r.rankerId,
    family: r.family,
    metrics: evaluateRanking(r.ranked, poolDonors, poolAmounts),
    runtimeMs: r.runtimeMs,
  }));
  rows.sort(
    (a, b) =>
      b.metrics.ndcgAt20 - a.metrics.ndcgAt20 ||
      b.metrics.precisionAt20 - a.metrics.precisionAt20 ||
      (a.rankerId < b.rankerId ? -1 : 1),
  );
  return { rows, poolDonors: poolDonors.size, poolN: poolIds.length };
}
