import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATASET_VERSION } from "../config.js";
import { EVIDENCE_VERSION, stableStringify } from "../givecampus/criterion.js";

export interface EmbeddingCacheIdentity {
  datasetVersion?: string;
  evidenceVersion?: string;
  asOf: string;
  itemCardHash: string;
  model: string;
}

export interface CachedEmbedding {
  vector: number[];
  dimensions: number;
  inputTokens: number;
}

export function embeddingCacheKey(identity: EmbeddingCacheIdentity): string {
  const canonical = stableStringify({
    dataset_version: identity.datasetVersion ?? DATASET_VERSION,
    evidence_version: identity.evidenceVersion ?? EVIDENCE_VERSION,
    as_of: identity.asOf,
    item_card_hash: identity.itemCardHash,
    model: identity.model,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

export class EmbeddingCache {
  private readonly db: Database.Database;

  constructor(cachePath = path.join("data", "retrieval-cache.sqlite")) {
    if (cachePath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(cachePath)), { recursive: true });
    this.db = new Database(cachePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS embedding_cache (
      cache_key TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      input_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

  get(cacheKey: string, model: string): CachedEmbedding | null {
    const row = this.db
      .prepare(`SELECT model, dimensions, vector, input_tokens FROM embedding_cache WHERE cache_key = ?`)
      .get(cacheKey) as { model: string; dimensions: number; vector: Buffer; input_tokens: number } | undefined;
    if (!row) return null;
    if (row.model !== model || row.dimensions < 1 || row.vector.byteLength !== row.dimensions * 4) {
      this.db.prepare(`DELETE FROM embedding_cache WHERE cache_key = ?`).run(cacheKey);
      return null;
    }
    const vector = Array.from({ length: row.dimensions }, (_, i) => row.vector.readFloatLE(i * 4));
    if (vector.some((value) => !Number.isFinite(value))) {
      this.db.prepare(`DELETE FROM embedding_cache WHERE cache_key = ?`).run(cacheKey);
      return null;
    }
    return { vector, dimensions: row.dimensions, inputTokens: row.input_tokens };
  }

  set(cacheKey: string, model: string, vector: readonly number[], inputTokens: number): void {
    if (vector.length < 1 || vector.some((value) => !Number.isFinite(value))) {
      throw new Error("Embedding vector must contain finite values");
    }
    if (!Number.isInteger(inputTokens) || inputTokens < 0) throw new Error("Invalid embedding token count");
    const blob = Buffer.allocUnsafe(vector.length * 4);
    vector.forEach((value, i) => blob.writeFloatLE(value, i * 4));
    this.db.prepare(`INSERT OR REPLACE INTO embedding_cache
      (cache_key, model, dimensions, vector, input_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(cacheKey, model, vector.length, blob, inputTokens, new Date().toISOString());
  }

  get size(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM embedding_cache`).get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
