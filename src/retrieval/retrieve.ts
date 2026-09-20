import crypto from "node:crypto";
import { DATASET_VERSION } from "../config.js";
import { EVIDENCE_VERSION } from "../givecampus/criterion.js";
import type { TypedFilter } from "../pipeline/rubric.js";
import { rankBm25, type RetrievalId } from "./bm25.js";
import { EmbeddingCache, embeddingCacheKey } from "./embedding-cache.js";
import {
  EMBEDDING_INPUT_USD_PER_MTOK,
  type EmbeddingProvider,
} from "./embeddings.js";
import type { ConstituentCard, ConstituentCardFields } from "./item-card.js";
import { reciprocalRankFusion } from "./rrf.js";

/** Interactive default: hybrid retrieval narrows the full population before Jev judgment. */
export const DEFAULT_CANDIDATE_CAP = 200;
export const MAX_CANDIDATE_CAP = 20_000;
const DEFAULT_RRF_K = 60;

function folded(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function compareScalar(a: string | number | boolean, b: string | number | boolean): number | null {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (typeof a === "string" && typeof b === "string") {
    const left = folded(a);
    const right = folded(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return null;
}

function passesFilter(fields: ConstituentCardFields, filter: TypedFilter): boolean {
  const actual = fields[filter.field] as string | number | string[] | undefined;
  if (actual === undefined || actual === null) return false;
  const expected = filter.value;
  if (expected === null) return false;
  switch (filter.op) {
    case "eq": return !Array.isArray(actual) && !Array.isArray(expected) && compareScalar(actual, expected) === 0;
    case "neq": {
      if (Array.isArray(actual) || Array.isArray(expected)) return false;
      const comparison = compareScalar(actual, expected);
      return comparison !== null && comparison !== 0;
    }
    case "contains": {
      if (typeof expected !== "string") return false;
      return Array.isArray(actual)
        ? actual.some((value) => folded(value).includes(folded(expected)))
        : typeof actual === "string" && folded(actual).includes(folded(expected));
    }
    case "in": {
      if (!Array.isArray(expected)) return false;
      return Array.isArray(actual)
        ? actual.some((value) => expected.some((item) => compareScalar(value, item) === 0))
        : expected.some((item) => compareScalar(actual, item) === 0);
    }
    case "between": {
      if (Array.isArray(actual) || !Array.isArray(expected) || expected.length !== 2) return false;
      const lower = compareScalar(actual, expected[0]!);
      const upper = compareScalar(actual, expected[1]!);
      return lower !== null && upper !== null && lower >= 0 && upper <= 0;
    }
    case "gte":
    case "gt":
    case "lte":
    case "lt": {
      if (Array.isArray(actual) || Array.isArray(expected)) return false;
      const cmp = compareScalar(actual, expected);
      if (cmp === null) return false;
      if (filter.op === "gte") return cmp >= 0;
      if (filter.op === "gt") return cmp > 0;
      if (filter.op === "lte") return cmp <= 0;
      return cmp < 0;
    }
  }
}

/** Conjunctive, typed rubric filtering over already eligible card records. */
export function applyTypedFilters<T extends { fields: ConstituentCardFields }>(
  cards: readonly T[],
  filters: readonly TypedFilter[],
): T[] {
  return cards.filter((card) => filters.every((filter) => passesFilter(card.fields, filter)));
}

export interface EmbeddingTelemetry {
  model: string;
  batches: number;
  cacheHits: number;
  liveInputs: number;
  liveInputTokens: number;
  cachedInputTokens: number;
  estimatedLiveCostUsd: number | null;
  latencyBatchMs: { p50: number; p95: number; n: number };
}

export interface RetrievalOptions {
  candidateCap?: number;
  rrfK?: number;
  filters?: readonly TypedFilter[];
  embedder?: EmbeddingProvider;
  embeddingCache?: EmbeddingCache;
  batchSize?: number;
  datasetVersion?: string;
  evidenceVersion?: string;
  onEmbeddingTelemetry?: (telemetry: EmbeddingTelemetry) => void;
}

export interface RetrievalResult {
  /** The pool is only a candidate filter. Items are scored downstream by rubric/code. */
  candidates: ConstituentCard[];
  filteredCount: number;
  candidateCount: number;
  candidateCap: number;
  usedAllSurvivors: boolean;
  bm25RankLists: number;
  embeddingRankLists: number;
  embedding?: EmbeddingTelemetry;
}

interface EmbeddingInput {
  cacheIdentity: string;
  text: string;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error("Embedding dimensions do not match");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function allocateTokens(total: number, inputs: readonly EmbeddingInput[]): number[] {
  if (inputs.length === 0) return [];
  const weights = inputs.map((input) => Math.max(1, input.text.length));
  const denominator = weights.reduce((sum, weight) => sum + weight, 0);
  const result = weights.map((weight) => Math.floor(total * weight / denominator));
  result[result.length - 1]! += total - result.reduce((sum, value) => sum + value, 0);
  return result;
}

async function embedForRetrieval(args: {
  cards: readonly ConstituentCard[];
  phrasings: readonly string[];
  provider: EmbeddingProvider;
  cache?: EmbeddingCache;
  batchSize: number;
  datasetVersion: string;
  evidenceVersion: string;
  asOf: string;
}): Promise<{ vectors: Map<string, number[]>; telemetry: EmbeddingTelemetry }> {
  const { cards, phrasings, provider, cache } = args;
  const inputs: EmbeddingInput[] = [];
  const seen = new Set<string>();
  for (const phrase of phrasings) {
    const key = `query:${sha256(phrase)}`;
    if (!seen.has(key)) { inputs.push({ cacheIdentity: key, text: phrase }); seen.add(key); }
  }
  for (const card of cards) {
    const key = `card:${card.hash}`;
    if (!seen.has(key)) { inputs.push({ cacheIdentity: key, text: card.searchText }); seen.add(key); }
  }

  const vectors = new Map<string, number[]>();
  const missing: EmbeddingInput[] = [];
  let cacheHits = 0;
  let cachedInputTokens = 0;
  for (const input of inputs) {
    const cacheKey = embeddingCacheKey({
      datasetVersion: args.datasetVersion,
      evidenceVersion: args.evidenceVersion,
      asOf: args.asOf,
      itemCardHash: input.cacheIdentity,
      model: provider.model,
    });
    const cached = cache?.get(cacheKey, provider.model);
    if (cached) {
      vectors.set(input.cacheIdentity, cached.vector);
      cacheHits += 1;
      cachedInputTokens += cached.inputTokens;
    } else {
      missing.push(input);
    }
  }

  const latencies: number[] = [];
  let liveInputTokens = 0;
  let batches = 0;
  for (let start = 0; start < missing.length; start += args.batchSize) {
    const chunk = missing.slice(start, start + args.batchSize);
    const beganAt = Date.now();
    const response = await provider.embed(chunk.map((input) => input.text));
    const latencyMs = Date.now() - beganAt;
    if (response.vectors.length !== chunk.length || response.vectors.length === 0) {
      throw new Error("Embedding provider returned an unexpected vector count");
    }
    const dimensions = response.vectors[0]!.length;
    if (dimensions < 1 || response.vectors.some((vector) =>
      vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))) {
      throw new Error("Embedding provider returned invalid vectors");
    }
    if (!Number.isInteger(response.inputTokens) || response.inputTokens < 0) {
      throw new Error("Embedding provider returned invalid input token count");
    }
    const tokensPerInput = allocateTokens(response.inputTokens, chunk);
    chunk.forEach((input, index) => {
      const vector = response.vectors[index]!;
      vectors.set(input.cacheIdentity, vector);
      if (cache) {
        const cacheKey = embeddingCacheKey({
          datasetVersion: args.datasetVersion,
          evidenceVersion: args.evidenceVersion,
          asOf: args.asOf,
          itemCardHash: input.cacheIdentity,
          model: provider.model,
        });
        cache.set(cacheKey, provider.model, vector, tokensPerInput[index]!);
      }
    });
    batches += 1;
    latencies.push(latencyMs);
    liveInputTokens += response.inputTokens;
  }
  const telemetry: EmbeddingTelemetry = {
    model: provider.model,
    batches,
    cacheHits,
    liveInputs: missing.length,
    liveInputTokens,
    cachedInputTokens,
    estimatedLiveCostUsd: provider.model === "text-embedding-3-small"
      ? Math.round(liveInputTokens / 1_000_000 * EMBEDDING_INPUT_USD_PER_MTOK * 1_000_000) / 1_000_000
      : null,
    latencyBatchMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), n: latencies.length },
  };
  return { vectors, telemetry };
}

/**
 * Apply typed code filters to cards that have already passed deterministic
 * eligibility, then fuse independent BM25 and embedding rank lists.
 * Retrieval determines pool membership only: no similarity/RRF score is returned.
 */
export async function retrieveCandidates(
  cards: readonly ConstituentCard[],
  phrasings: readonly string[],
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  if (phrasings.length < 1 || phrasings.length > 5 || phrasings.some((phrase) => !phrase.trim())) {
    throw new Error("Retrieval requires 1..5 non-empty query phrasings");
  }
  const candidateCap = options.candidateCap ?? DEFAULT_CANDIDATE_CAP;
  if (!Number.isInteger(candidateCap) || candidateCap < 1 || candidateCap > MAX_CANDIDATE_CAP) {
    throw new Error(`candidateCap must be an integer in 1..${MAX_CANDIDATE_CAP}`);
  }
  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  const survivors = applyTypedFilters(cards, options.filters ?? []);
  const asOf = survivors[0]?.asOf;
  if (asOf && survivors.some((card) => card.asOf !== asOf)) {
    throw new Error("Candidate cards must share one as-of date");
  }
  if (survivors.length <= candidateCap) {
    return {
      candidates: [...survivors],
      filteredCount: survivors.length,
      candidateCount: survivors.length,
      candidateCap,
      usedAllSurvivors: true,
      bm25RankLists: 0,
      embeddingRankLists: 0,
    };
  }

  const idMap = new Map<RetrievalId, ConstituentCard>(survivors.map((card) => [card.constituentId, card]));
  const textDocuments = survivors.map((card) => ({ id: card.constituentId, text: card.searchText }));
  const rankLists: RetrievalId[][] = phrasings.map((phrase) =>
    rankBm25(phrase, textDocuments).map((row) => row.id),
  );
  let embeddingTelemetry: EmbeddingTelemetry | undefined;
  let embeddingRankLists = 0;
  if (options.embedder) {
    const batchSize = options.batchSize ?? 100;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new Error("Embedding batchSize must be an integer in 1..500");
    }
    const { vectors, telemetry } = await embedForRetrieval({
      cards: survivors,
      phrasings,
      provider: options.embedder,
      cache: options.embeddingCache,
      batchSize,
      datasetVersion: options.datasetVersion ?? DATASET_VERSION,
      evidenceVersion: options.evidenceVersion ?? EVIDENCE_VERSION,
      asOf: asOf!,
    });
    embeddingTelemetry = telemetry;
    for (const phrase of [...new Set(phrasings)]) {
      const queryKey = `query:${sha256(phrase)}`;
      const queryVector = vectors.get(queryKey);
      if (!queryVector) throw new Error("Embedding provider did not return a query vector");
      rankLists.push(survivors
        .map((card) => ({ id: card.constituentId, score: cosine(queryVector, vectors.get(`card:${card.hash}`)!) }))
        .sort((a, b) => b.score - a.score || a.id - b.id)
        .map((row) => row.id));
      embeddingRankLists += 1;
    }
  }
  if (embeddingTelemetry) options.onEmbeddingTelemetry?.(embeddingTelemetry);

  const selectedIds = reciprocalRankFusion(rankLists, rrfK).slice(0, candidateCap).map((row) => row.id);
  const candidates = selectedIds.flatMap((id) => {
    const card = idMap.get(id);
    return card ? [card] : [];
  });
  return {
    candidates,
    filteredCount: survivors.length,
    candidateCount: candidates.length,
    candidateCap,
    usedAllSurvivors: false,
    bm25RankLists: phrasings.length,
    embeddingRankLists,
    embedding: embeddingTelemetry,
  };
}
