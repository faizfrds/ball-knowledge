/**
 * Job 1 — compile a natural-language query + explicit available-field
 * schema into a strict typed rubric JSON.
 *
 * Safety model (mirrors `src/givecampus/criterion.ts` non-negotiables):
 * - Output is a TYPED object validated here. There is no `where`/`sql`
 *   string output anywhere; downstream binds typed clauses as parameters.
 * - Only allowlisted fields/operators and literal Jev headline question
 *   IDs survive validation. Anything else => safe default fallback.
 * - Injection in the NL query (e.g. "ignore instructions", SQL fragments)
 *   cannot leak into the output: the validator drops unknown tokens and
 *   the fallback triggers on any violation the model emits.
 * - One LLM call per compile. Never per candidate.
 */

import { callStructuredJson, type FetchFn, type LlmTelemetry } from "./client.js";
import { resolveLlmEnv } from "./config.js";

/** Literal headline Jev question IDs (client-side keys, see src/givecampus/jev.ts). */
export const HEADLINE_JEV_QUESTIONS = [
  "has_recent_gift",
  "has_repeat_giving",
  "title_employer_context_present",
  "engagement_level",
  "capacity_evidence_strength",
  "permitted_action",
] as const;

export type JevQuestionId = (typeof HEADLINE_JEV_QUESTIONS)[number];

/** Fields the compiler may reference. Subset must appear in the caller-supplied schema. */
export const ALLOWLISTED_FIELDS = [
  "city",
  "state",
  "affiliationType",
  "lastGiftDate",
  "giftCount24mo",
  "lifetimeTotal",
  "explicitRating",
  "engagementEvents",
  "title",
  "employer",
] as const;

export type RubricField = (typeof ALLOWLISTED_FIELDS)[number];

export const ALLOWLISTED_OPS = ["eq", "neq", "gte", "lte", "gt", "lt", "contains", "in", "between"] as const;

export type RubricOp = (typeof ALLOWLISTED_OPS)[number];

export interface AvailableField {
  name: string;
  kind: string;
}

export interface RubricClause {
  field: RubricField;
  op: RubricOp;
  value: string | number | boolean | null | Array<string | number>;
}

export interface CompiledRubric {
  id: string;
  version: string;
  filters: RubricClause[];
  jevQuestions: JevQuestionId[];
}

/** Safe default headline rubric: no filters, all six literal questions. */
export const DEFAULT_HEADLINE_RUBRIC: CompiledRubric = {
  id: "giving-day-worklist",
  version: "criterion-v1",
  filters: [],
  jevQuestions: [...HEADLINE_JEV_QUESTIONS],
};

export interface CompileOutcome {
  rubric: CompiledRubric;
  fallback: boolean;
  reason: string | null;
  telemetry: LlmTelemetry | null;
}

const EXECUTABLE_TOKENS = ["select ", "where ", "drop ", "delete ", ";--", "/*", "union ", "insert ", "update "];

function isPlainValue(v: unknown): v is RubricClause["value"] {
  if (v === null) return true;
  if (typeof v === "string") return v.length <= 120;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "boolean") return true;
  if (Array.isArray(v)) {
    if (v.length > 20) return false;
    return v.every((e) => typeof e === "string" || typeof e === "number");
  }
  return false;
}

/** Strict code-side validator. Returns the sanitized rubric or throws. */
export function validateRubric(input: unknown, availableFields: AvailableField[]): CompiledRubric {
  const allowed = new Set<string>();
  for (const f of availableFields) {
    if (ALLOWLISTED_FIELDS.includes(f.name as RubricField)) allowed.add(f.name);
  }
  const o = input as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("rubric must be an object");
  const filters = o.filters;
  if (!Array.isArray(filters)) throw new Error("rubric.filters must be an array");
  if (filters.length > 12) throw new Error("too many filters (max 12)");
  const clauses: RubricClause[] = [];
  for (const c of filters) {
    const cl = c as Record<string, unknown>;
    const field = cl.field;
    const op = cl.op;
    if (typeof field !== "string" || !allowed.has(field)) throw new Error(`disallowed field: ${String(field)}`);
    if (typeof op !== "string" || !ALLOWLISTED_OPS.includes(op as RubricOp)) throw new Error(`disallowed op: ${String(op)}`);
    if (!isPlainValue(cl.value)) throw new Error(`invalid clause value for field ${field}`);
    if (typeof cl.value === "string") {
      const low = cl.value.toLowerCase();
      for (const tok of EXECUTABLE_TOKENS) {
        if (low.includes(tok)) throw new Error(`executable fragment in value for field ${field}`);
      }
    }
    clauses.push({ field: field as RubricField, op: op as RubricOp, value: cl.value as RubricClause["value"] });
  }
  const qs = o.jevQuestions;
  if (!Array.isArray(qs) || qs.length === 0) throw new Error("jevQuestions must be a non-empty array");
  const seen = new Set<JevQuestionId>();
  for (const q of qs) {
    if (typeof q !== "string" || !HEADLINE_JEV_QUESTIONS.includes(q as JevQuestionId)) {
      throw new Error(`unknown jev question: ${String(q)}`);
    }
    seen.add(q as JevQuestionId);
  }
  const id = typeof o.id === "string" && o.id ? o.id.slice(0, 80) : DEFAULT_HEADLINE_RUBRIC.id;
  const version = typeof o.version === "string" && o.version ? o.version.slice(0, 40) : DEFAULT_HEADLINE_RUBRIC.version;
  return { id, version, filters: clauses, jevQuestions: [...seen] };
}

function fallback(reason: string): CompileOutcome {
  return {
    rubric: { ...DEFAULT_HEADLINE_RUBRIC, filters: [], jevQuestions: [...DEFAULT_HEADLINE_RUBRIC.jevQuestions] },
    fallback: true,
    reason,
    telemetry: null,
  };
}

const SYSTEM_PROMPT = [
  "You compile a fundraising-worklist natural-language query into a STRICT typed rubric JSON.",
  "Output JSON only, with keys: id (string), version (string), filters (array), jevQuestions (array).",
  `Allowed filter fields (subset of caller schema, never invent others): ${ALLOWLISTED_FIELDS.join(", ")}.`,
  `Allowed ops: ${ALLOWLISTED_OPS.join(", ")}.`,
  `Allowed jevQuestions (literal IDs only, pick the needed subset): ${HEADLINE_JEV_QUESTIONS.join(", ")}.`,
  "Rules: no SQL, no WHERE strings, no executable code, no commentary outside JSON.",
  "Clause values are plain strings/numbers/booleans/null or small arrays (<=20 items, strings <=120 chars).",
  "title/employer are weak context only — never use them for capacity comparisons.",
  "If the request asks for anything outside the allowlists, emit the closest allowlisted rubric (empty filters if unsure).",
].join("\n");

/**
 * Compile NL -> rubric with one structured LLM call. All output is
 * validated in code; ANY failure returns the safe default headline rubric
 * with `fallback: true` (never throws except browser context).
 */
export async function compileRubric(
  nlQuery: string,
  availableFields: AvailableField[],
  opts: { model?: string; fetchFn?: FetchFn; timeoutMs?: number; maxRetries?: number } = {},
): Promise<CompileOutcome> {
  const query = (nlQuery ?? "").slice(0, 2000);
  if (!query.trim()) return { ...fallback("empty query"), reason: "empty query" };
  if (!Array.isArray(availableFields) || availableFields.length === 0 || availableFields.length > 64) {
    return fallback("invalid available-field schema");
  }
  const schemaText = availableFields
    .slice(0, 64)
    .map((f) => `- ${String(f.name).slice(0, 80)} (${String(f.kind).slice(0, 40)})`)
    .join("\n");
  const env = resolveLlmEnv();
  if (!env.apiKey && !opts.fetchFn) return fallback("missing_key");
  try {
    const { jsonText, telemetry } = await callStructuredJson({
      system: SYSTEM_PROMPT,
      user: `Query: ${query}\n\nAvailable fields:\n${schemaText}`,
      model: opts.model,
      fetchFn: opts.fetchFn,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { ...fallback("model returned non-JSON"), telemetry };
    }
    try {
      const rubric = validateRubric(parsed, availableFields);
      return { rubric, fallback: false, reason: null, telemetry };
    } catch (e) {
      return { ...fallback((e as Error).message), telemetry };
    }
  } catch (e) {
    return fallback((e as Error).message ?? "llm error");
  }
}
