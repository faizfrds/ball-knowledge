import fs from "node:fs";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import type Database from "better-sqlite3";

/** A single persisted model answer for one criterion and one scoped state. */
export interface CachedQuestionAnswer {
  answer: Record<string, unknown>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface QuestionAnswerCache {
  get(cacheKey: string): { hit: true; value: CachedQuestionAnswer } | { hit: false };
  set(record: {
    cacheKey: string;
    constituentId: number;
    questionId: string;
    questionHash: string;
    relevantStateHash: string;
    datasetVersion: string;
    evidenceVersion: string;
    asOf: string;
    model: string;
    value: CachedQuestionAnswer;
  }): void;
  readonly size: number;
  close(): void;
}

/** SQLite cache keyed by criterion text plus the criterion's field-scoped state. */
export class SqliteQuestionAnswerCache implements QuestionAnswerCache {
  private readonly db: Database.Database;

  constructor(cachePath = path.join("data", "question-cache.sqlite")) {
    fs.mkdirSync(path.dirname(path.resolve(cachePath)), { recursive: true });
    this.db = new DatabaseConstructor(cachePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS question_answers (
        cache_key TEXT PRIMARY KEY,
        constituent_id INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        question_hash TEXT NOT NULL,
        relevant_state_hash TEXT NOT NULL,
        dataset_version TEXT NOT NULL,
        evidence_version TEXT NOT NULL,
        as_of TEXT NOT NULL,
        model TEXT NOT NULL,
        answer_json TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  get(cacheKey: string): { hit: true; value: CachedQuestionAnswer } | { hit: false } {
    const row = this.db
      .prepare(`SELECT answer_json, model, input_tokens, output_tokens, latency_ms
                FROM question_answers WHERE cache_key = ?`)
      .get(cacheKey) as
      | { answer_json: string; model: string; input_tokens: number; output_tokens: number; latency_ms: number }
      | undefined;
    if (!row) return { hit: false };
    this.db.prepare(`UPDATE question_answers SET hit_count = hit_count + 1 WHERE cache_key = ?`).run(cacheKey);
    return {
      hit: true,
      value: {
        answer: JSON.parse(row.answer_json) as Record<string, unknown>,
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        latencyMs: row.latency_ms,
      },
    };
  }

  set(record: {
    cacheKey: string;
    constituentId: number;
    questionId: string;
    questionHash: string;
    relevantStateHash: string;
    datasetVersion: string;
    evidenceVersion: string;
    asOf: string;
    model: string;
    value: CachedQuestionAnswer;
  }): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO question_answers (
        cache_key, constituent_id, question_id, question_hash, relevant_state_hash,
        dataset_version, evidence_version, as_of, model, answer_json,
        input_tokens, output_tokens, latency_ms, created_at, hit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(
        record.cacheKey,
        record.constituentId,
        record.questionId,
        record.questionHash,
        record.relevantStateHash,
        record.datasetVersion,
        record.evidenceVersion,
        record.asOf,
        record.model,
        JSON.stringify(record.value.answer),
        record.value.inputTokens,
        record.value.outputTokens,
        record.value.latencyMs,
        new Date().toISOString(),
      );
  }

  get size(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM question_answers`).get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
