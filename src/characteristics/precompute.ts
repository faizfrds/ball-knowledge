/**
 * Jev characteristic precomputation for GiveCampus.
 *
 * Materializes yes/no (noul) answers for the 100-characteristic bank over a
 * bounded candidate pool: per constituent, the bank is chunked into
 * systemOne calls (each call = one constituent x chunk), cached in a
 * gitignored SQLite store keyed by (dataset/evidence/asOf/state/question/
 * model). Failed ids produce explicit errors — never imputed answers.
 * Local-deterministic mock client exists for tests and no-key smoke runs
 * only; benchmark claims must use the live client.
 */
import type Database from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  makeCacheKey,
  sha256Hex,
  stableStringify,
  EVIDENCE_VERSION,
} from "../givecampus/criterion.js";
import type { JevAnswer, JevClient, JevQuestion, JevState } from "../givecampus/jev.js";
import { JEV_MODEL } from "../givecampus/jev.js";
import { DATASET_VERSION } from "../config.js";
import { buildJevStateForId, isModelRejection } from "../benchmark/jev-live.js";
import {
  buildCharacteristicQuestions,
  evaluateCharacteristic,
  CHARACTERISTIC_COUNT,
  type CharacteristicQuestion,
} from "./question-library.js";

export type Verdict = "yes" | "no" | "uncertain";

export function noulVerdict(noul: number): Verdict {
  if (!Number.isFinite(noul)) return "uncertain";
  if (noul >= 0.7) return "yes";
  if (noul <= 0.3) return "no";
  return "uncertain";
}

export interface ChunkAnswers {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  retries: number;
}

export interface CharacteristicCache {
  get(key: string): ChunkAnswers | null;
  set(key: string, value: ChunkAnswers): void;
  readonly size: number;
  close(): void;
}

export class MapCharacteristicCache implements CharacteristicCache {
  private map = new Map<string, ChunkAnswers>();
  get(key: string) {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: ChunkAnswers) {
    this.map.set(key, value);
  }
  get size() {
    return this.map.size;
  }
  close() {}
}

/**
 * SQLite KV cache. Default `data/characteristic-cache.sqlite` is gitignored
 * (`data/*.sqlite*`), so precomputed answers never commit.
 */
export class SqliteCharacteristicCache implements CharacteristicCache {
  private db: Database.Database;
  constructor(cachePath = "data/characteristic-cache.sqlite") {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    this.db = new DatabaseConstructor(cachePath) as Database.Database;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS characteristic_cache (key TEXT PRIMARY KEY, model TEXT NOT NULL, answers TEXT NOT NULL, usage TEXT NOT NULL, latency_ms INTEGER NOT NULL, retries INTEGER NOT NULL, created_at TEXT NOT NULL)`,
    );
  }
  get(key: string): ChunkAnswers | null {
    const row = this.db
      .prepare(`SELECT model, answers, usage, latency_ms, retries FROM characteristic_cache WHERE key = ?`)
      .get(key) as { model: string; answers: string; usage: string; latency_ms: number; retries: number } | undefined;
    if (!row) return null;
    return {
      model: row.model,
      answers: JSON.parse(row.answers) as Record<string, JevAnswer>,
      usage: JSON.parse(row.usage) as { input_tokens: number; output_tokens: number },
      latencyMs: row.latency_ms,
      retries: row.retries,
    };
  }
  set(key: string, value: ChunkAnswers) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO characteristic_cache (key, model, answers, usage, latency_ms, retries, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, value.model, JSON.stringify(value.answers), JSON.stringify(value.usage), value.latencyMs, value.retries, new Date().toISOString());
  }
  get size() {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM characteristic_cache`).get() as { n: number }).n;
  }
  close() {
    this.db.close();
  }
}

export interface ChunkRecord {
  constituentId: number;
  chunkIndex: number;
  questionIds: string[];
  model: string;
  cacheHit: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  error?: string;
  verdicts: Record<string, Verdict>;
}

export interface PrecomputeResult {
  records: ChunkRecord[];
  verdictsByConstituent: Map<number, Record<string, Verdict>>;
  liveCalls: number;
  cacheHits: number;
  fallbackUsed: boolean;
  inputTokens: number;
  outputTokens: number;
  errors: { constituentId: number; chunkIndex: number; error: string }[];
  questionCount: number;
}

function stateHashOf(state: JevState): string {
  return sha256Hex(stableStringify(state)).slice(0, 16);
}

function questionsHashOf(byId: Record<string, JevQuestion>): string {
  return sha256Hex(stableStringify(byId)).slice(0, 16);
}

function extractVerdicts(answerMap: Record<string, JevAnswer>, questionIds: string[]): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const id of questionIds) {
    const a = answerMap[id] as { noul?: unknown } | undefined;
    const v = a?.noul;
    out[id] = typeof v === "number" && Number.isFinite(v) ? noulVerdict(v) : "uncertain";
  }
  return out;
}

/**
 * Precompute characteristic verdicts for a fixed pool. Concurrency-limited
 * with model fallback (pinned then jev-latest on model rejection); a global
 * live-call budget bounds cost. Cache hits are free and never counted.
 */
export async function precomputeCharacteristics(args: {
  db: Database.Database;
  poolIds: number[];
  asOf: string;
  client: JevClient;
  cache: CharacteristicCache;
  questions?: readonly CharacteristicQuestion[];
  chunkSize?: number;
  models?: readonly string[];
  concurrency?: number;
  maxLiveCalls?: number;
}): Promise<PrecomputeResult> {
  const allQuestions = args.questions ?? buildCharacteristicQuestions();
  if (allQuestions.length !== CHARACTERISTIC_COUNT) {
    throw new Error(`Characteristic bank must hold exactly ${CHARACTERISTIC_COUNT} questions (got ${allQuestions.length})`);
  }
  const chunkSize = args.chunkSize ?? 25;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > allQuestions.length) {
    throw new Error(`chunkSize must be an integer in 1..${allQuestions.length}`);
  }
  const models = args.models ?? ["jev-1.13.0", "jev-latest"];
  const concurrency = Math.max(1, Math.min(8, args.concurrency ?? 4));
  const maxLiveCalls = args.maxLiveCalls ?? 1500;
  const chunks: { index: number; byId: Record<string, JevQuestion>; qHash: string; ids: string[] }[] = [];
  for (let i = 0; i < allQuestions.length; i += chunkSize) {
    const slice = allQuestions.slice(i, i + chunkSize).sort((a, b) => (a.id < b.id ? -1 : 1));
    const byId: Record<string, JevQuestion> = {};
    for (const q of slice) byId[q.id] = q.question;
    chunks.push({ index: chunks.length, byId, qHash: questionsHashOf(byId), ids: slice.map((q) => q.id) });
  }

  const verdictsByConstituent = new Map<number, Record<string, Verdict>>();
  const records: ChunkRecord[] = [];
  const errors: { constituentId: number; chunkIndex: number; error: string }[] = [];
  let liveCalls = 0;
  let cacheHits = 0;
  let fallbackUsed = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const queue = [...args.poolIds].sort((a, b) => a - b);

  async function worker(): Promise<void> {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      const state = buildJevStateForId(args.db, id, args.asOf);
      const stateHash = stateHashOf(state);
      const merged: Record<string, Verdict> = {};
      for (const chunk of chunks) {
        const record: ChunkRecord = {
          constituentId: id,
          chunkIndex: chunk.index,
          questionIds: chunk.ids,
          model: models[0]!,
          cacheHit: false,
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          retries: 0,
          verdicts: {},
        };
        let done = false;
        for (const [mi, model] of models.entries()) {
          if (done) break;
          const key = makeCacheKey({
            datasetVersion: DATASET_VERSION,
            evidenceVersion: EVIDENCE_VERSION,
            asOf: state.as_of_date,
            stateHash,
            questionsHash: chunk.qHash,
            model,
          });
          const cached = args.cache.get(key);
          if (cached) {
            record.model = cached.model;
            record.cacheHit = true;
            record.latencyMs = cached.latencyMs;
            record.inputTokens = cached.usage.input_tokens;
            record.outputTokens = cached.usage.output_tokens;
            record.retries = cached.retries;
            record.verdicts = extractVerdicts(cached.answers, chunk.ids);
            cacheHits += 1;
            if (mi > 0) fallbackUsed = true;
            done = true;
            break;
          }
          if (liveCalls >= maxLiveCalls) {
            record.error = "call_budget_exhausted";
            record.verdicts = extractVerdicts({}, chunk.ids);
            errors.push({ constituentId: id, chunkIndex: chunk.index, error: record.error });
            done = true;
            break;
          }
          const beganAt = Date.now();
          try {
            // Reserve the budget synchronously before the call so concurrent
            // workers never exceed the cap by more than an in-flight call.
            liveCalls += 1;
            const raw = await args.client.systemOne({ state, questions: chunk.byId, model });
            if (raw.model !== model && /jev/i.test(String(raw.model))) fallbackUsed = true;
            inputTokens += raw.usage.input_tokens;
            outputTokens += raw.usage.output_tokens;
            args.cache.set(key, {
              model: raw.model,
              answers: raw.answers,
              usage: raw.usage,
              latencyMs: Date.now() - beganAt,
              retries: raw.retries ?? 0,
            });
            record.model = raw.model;
            record.latencyMs = Date.now() - beganAt;
            record.inputTokens = raw.usage.input_tokens;
            record.outputTokens = raw.usage.output_tokens;
            record.retries = raw.retries ?? 0;
            record.verdicts = extractVerdicts(raw.answers, chunk.ids);
            done = true;
          } catch (e) {
            if (isModelRejection(e) && mi < models.length - 1) {
              fallbackUsed = true;
              continue;
            }
            record.error = (e as Error).message ?? "jev_error";
            record.verdicts = extractVerdicts({}, chunk.ids);
            errors.push({ constituentId: id, chunkIndex: chunk.index, error: record.error });
            done = true;
          }
        }
        records.push(record);
        for (const [qid, verdict] of Object.entries(record.verdicts)) merged[qid] = verdict;
      }
      verdictsByConstituent.set(id, merged);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  return {
    records,
    verdictsByConstituent,
    liveCalls,
    cacheHits,
    fallbackUsed,
    inputTokens,
    outputTokens,
    errors,
    questionCount: allQuestions.length,
  };
}

/** Deterministic local client: answers every question via the code mirror. Tests/no-key simulation only. */
export class LocalCharacteristicClient implements JevClient {
  calls = 0;
  async systemOne(args: { state: JevState; questions: Record<string, JevQuestion>; model?: string }) {
    this.calls += 1;
    const answers: Record<string, JevAnswer> = {};
    for (const id of Object.keys(args.questions)) {
      const v = evaluateCharacteristic(args.state, id);
      answers[id] = { type: "noul", noul: v == null ? 0.5 : v ? 1 : 0 };
    }
    return {
      model: args.model ?? JEV_MODEL,
      answers,
      usage: { input_tokens: 1200, output_tokens: 40 },
      retries: 0,
    };
  }
}
