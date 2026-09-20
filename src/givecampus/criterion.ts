import crypto from "node:crypto";
import { AS_OF_DATE, DATASET_VERSION } from "../config.js";

/**
 * Typed, validated worklist rubric + filter schema.
 *
 * NON-NEGOTIABLE: filters are typed objects validated here and bound as
 * query parameters downstream. This module never builds executable filter
 * strings — there is no `where`/`sql` string output anywhere.
 */

export const SCORING_VERSION = "priority-index-v1";
export const EVIDENCE_VERSION = "ev-001";
export const MODEL_VERSION = "jev-1.13.0";

export interface ScoreWeights {
  r: number;
  f: number;
  m: number;
  e: number;
  n: number;
  c: number;
}

export interface ScoreThresholds {
  /** noul >= trueAt => true; <= falseAt => false; else unknown. */
  noulTrueAt: number;
  noulFalseAt: number;
  /** Priority subscore < dormantBelow with a paid history => "dormant" label. */
  dormantBelow: number;
  /** completeness < reviewBelow => review_needed. */
  reviewBelow: number;
}

export interface Criterion {
  id: string;
  version: string;
  scoringVersion: string;
  weights: ScoreWeights;
  thresholds: ScoreThresholds;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  r: 0.25,
  f: 0.2,
  m: 0.2,
  e: 0.15,
  n: 0.15,
  c: 0.05,
};

export const DEFAULT_THRESHOLDS: ScoreThresholds = {
  noulTrueAt: 0.7,
  noulFalseAt: 0.3,
  dormantBelow: 0.15,
  reviewBelow: 0.5,
};

export const DEFAULT_CRITERION: Criterion = {
  id: "giving-day-worklist",
  version: "criterion-v1",
  scoringVersion: SCORING_VERSION,
  weights: { ...DEFAULT_WEIGHTS },
  thresholds: { ...DEFAULT_THRESHOLDS },
};

export type SortOrder = "priority_desc";

export interface WorklistFilter {
  asOf: string;
  limit: number;
  offset: number;
  city?: string;
  state?: string;
  affiliationType?: string;
  /** Exclude current students from solicitation ranking (default true). */
  excludeStudentSolicit: boolean;
  sort: SortOrder;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t);
}

export function parseWorklistFilter(input: unknown): WorklistFilter {
  const o = (input ?? {}) as Record<string, unknown>;
  const asOf = typeof o.asOf === "string" && o.asOf ? o.asOf : AS_OF_DATE;
  if (!isValidDate(asOf)) throw new Error(`Invalid asOf date: ${String(o.asOf)}`);
  if (asOf > "2030-01-01" || asOf < "2000-01-01") {
    throw new Error(`asOf out of range: ${asOf}`);
  }
  const limitRaw = o.limit ?? 20;
  const offsetRaw = o.offset ?? 0;
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(`Invalid limit (1..200): ${String(o.limit)}`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    throw new Error(`Invalid offset: ${String(o.offset)}`);
  }
  const out: WorklistFilter = {
    asOf,
    limit,
    offset,
    excludeStudentSolicit: o.excludeStudentSolicit === false ? false : true,
    sort: "priority_desc",
  };
  if (o.city !== undefined) {
    if (typeof o.city !== "string" || o.city.length > 120) throw new Error("Invalid city");
    if (o.city) out.city = o.city;
  }
  if (o.state !== undefined) {
    if (typeof o.state !== "string" || o.state.length > 120) throw new Error("Invalid state");
    if (o.state) out.state = o.state;
  }
  if (o.affiliationType !== undefined) {
    if (typeof o.affiliationType !== "string" || o.affiliationType.length > 80) {
      throw new Error("Invalid affiliationType");
    }
    if (o.affiliationType) out.affiliationType = o.affiliationType;
  }
  if (o.sort !== undefined && o.sort !== "priority_desc") {
    throw new Error("Invalid sort (only priority_desc supported)");
  }
  return out;
}

export function parseCriterion(input: unknown): Criterion {
  if (input === undefined || input === null) return { ...DEFAULT_CRITERION };
  const o = input as Record<string, unknown>;
  const base: Criterion = {
    id: typeof o.id === "string" && o.id ? o.id : DEFAULT_CRITERION.id,
    version: typeof o.version === "string" && o.version ? o.version : DEFAULT_CRITERION.version,
    scoringVersion: SCORING_VERSION,
    weights: { ...(o.weights as ScoreWeights | undefined) ?? { ...DEFAULT_WEIGHTS } },
    thresholds: { ...(o.thresholds as ScoreThresholds | undefined) ?? { ...DEFAULT_THRESHOLDS } },
  };
  const w = base.weights;
  for (const k of ["r", "f", "m", "e", "n", "c"] as const) {
    const v = Number(w[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`Invalid weight ${k}`);
    w[k] = v;
  }
  const sum = w.r + w.f + w.m + w.e + w.n + w.c;
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`Weights must sum to 1 (got ${sum})`);
  const t = base.thresholds;
  if (!(t.noulFalseAt < t.noulTrueAt)) throw new Error("Thresholds require noulFalseAt < noulTrueAt");
  if (!(t.reviewBelow > 0 && t.reviewBelow <= 1)) throw new Error("Invalid reviewBelow");
  return base;
}

/** Canonical JSON: sorted keys, recursive — stable across runs for hashing. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function criterionHash(c: Criterion): string {
  return sha256Hex(stableStringify(c)).slice(0, 16);
}

export interface CacheKeyParts {
  datasetVersion?: string;
  evidenceVersion?: string;
  asOf: string;
  stateHash: string;
  questionsHash: string;
  model: string;
}

export function makeCacheKey(p: CacheKeyParts): string {
  const canon = stableStringify({
    dataset_version: p.datasetVersion ?? DATASET_VERSION,
    evidence_version: p.evidenceVersion ?? EVIDENCE_VERSION,
    as_of: p.asOf,
    state_hash: p.stateHash,
    questions_hash: p.questionsHash,
    model: p.model,
  });
  return `jev:${sha256Hex(canon).slice(0, 32)}`;
}
