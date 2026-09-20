import { callStructuredJson, type FetchFn, type LlmTelemetry } from "./client.js";
import { resolveLlmEnv } from "./config.js";
import {
  DEFAULT_GIVECAMPUS_RUBRIC,
  FIELD_NAMES,
  FILTER_OPS,
  validateCompiledRubric,
  type AvailableRubricField,
  type CompiledRubric,
} from "../pipeline/rubric.js";

export interface PipelineCompileOutcome {
  rubric: CompiledRubric;
  fallback: boolean;
  reason: string | null;
  telemetry: LlmTelemetry | null;
}

export const DEFAULT_RUBRIC_PLANNER_MODEL = "gpt-5.6-luna";

const SYSTEM_PROMPT = [
  "Compile one GiveCampus fundraising query into one strict JSON rubric.",
  "The model receives only the query and field schema; it never receives candidate records.",
  "Return exactly: id, version, route, filters, phrasings, gates, scores, bonuses, tags.",
  `Allowed fields: ${FIELD_NAMES.join(", ")}.`,
  `Allowed filter operations: ${FILTER_OPS.join(", ")}.`,
  "Use 2-5 retrieval phrasings, at most 12 filters, 6 gates, 6 scores, 4 bonuses, and 4 tags.",
  "JEV questions must be positive, literal, complete, and contain one judgment.",
  "Do not ask JEV to compare numbers, dates, or counts. Put exact comparisons in typed filters and refer only to code-derived bands in questions.",
  "Every criterion must list only fields needed to answer it. Missing evidence is unknown, never negative.",
  "Score criteria have 2-4 ordered text levels. Weights are finite and non-negative; code normalizes them.",
  "For GiveCampus next-action output, include a next_action tag whose options are exactly thank_you, event_invite, reunion_mailer, ask.",
  "Title and employer are weak context and never verified capacity.",
  "No SQL, executable strings, embeddings, semantic scores, similarity values, or vectors.",
  "Output JSON only.",
].join("\n");

function fallback(reason: string): PipelineCompileOutcome {
  return { rubric: structuredClone(DEFAULT_GIVECAMPUS_RUBRIC), fallback: true, reason, telemetry: null };
}

export async function compilePipelineRubric(
  query: string,
  availableFields: readonly AvailableRubricField[] = FIELD_NAMES,
  options: { model?: string; fetchFn?: FetchFn; timeoutMs?: number; maxRetries?: number } = {},
): Promise<PipelineCompileOutcome> {
  const cleanQuery = String(query ?? "").trim().slice(0, 2000);
  if (!cleanQuery) return fallback("empty query");
  if (!Array.isArray(availableFields) || availableFields.length === 0 || availableFields.length > 64) {
    return fallback("invalid available-field schema");
  }
  const env = resolveLlmEnv();
  if (!env.apiKey && !options.fetchFn) return fallback("missing_key");
  const schema = availableFields.map((field) => typeof field === "string" ? field : `${field.name} (${field.kind ?? "unknown"})`).join("\n");
  try {
    const response = await callStructuredJson({
      system: SYSTEM_PROMPT,
      user: `Query: ${cleanQuery}\n\nAvailable fields:\n${schema}`,
      model: options.model ?? DEFAULT_RUBRIC_PLANNER_MODEL,
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.jsonText);
    } catch {
      return { ...fallback("model returned non-JSON"), telemetry: response.telemetry };
    }
    try {
      const rubric = validateCompiledRubric(parsed, availableFields);
      ensureGiveCampusActionTag(rubric);
      return { rubric, fallback: false, reason: null, telemetry: response.telemetry };
    } catch (error) {
      return { ...fallback((error as Error).message), telemetry: response.telemetry };
    }
  } catch (error) {
    return fallback((error as Error).message || "llm error");
  }
}

function ensureGiveCampusActionTag(rubric: CompiledRubric): void {
  const tag = rubric.tags.find((candidate) => candidate.id === "next_action");
  const expected = ["ask", "event_invite", "reunion_mailer", "thank_you"];
  const actual = Object.keys(tag?.options ?? {}).sort();
  if (!tag || actual.length !== expected.length || actual.some((value, i) => value !== expected[i])) {
    throw new Error("next_action tag must contain exactly thank_you, event_invite, reunion_mailer, ask");
  }
}
