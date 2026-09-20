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
  "Use this exact JSON shape and include every shown key on every object:",
  JSON.stringify({
    id: "query-rubric",
    version: "1",
    route: "deep",
    filters: [{ field: "contactability", op: "neq", value: "none recorded" }],
    phrasings: ["first retrieval phrasing", "second retrieval phrasing"],
    gates: [{
      id: "contact_fit", question: "Does the record support contacting this constituent?",
      trueCriteria: "The provided fields support contact", falseCriteria: "The provided fields oppose contact",
      fields: ["contactability"], threshold: 0.7, unknownPolicy: "downrank",
    }],
    scores: [{
      id: "priority", question: "How strong is the evidence for this query?",
      levels: ["Little evidence", "Some evidence", "Strong evidence"],
      fields: ["gift_recency_band"], weight: 1,
    }],
    bonuses: [{
      id: "timely_signal", question: "Does the record show a timely outreach signal?",
      trueCriteria: "A timely signal is present", falseCriteria: "A timely signal is absent",
      fields: ["career_change_band"], weight: 1,
    }],
    tags: [{
      id: "next_action", question: "Which fundraising action best fits this constituent?",
      options: {
        thank_you: "Steward the constituent", event_invite: "Invite the constituent to an event",
        reunion_mailer: "Send reunion outreach", ask: "Make a fundraising ask",
      },
      fields: ["gift_recency_band", "engagement_events", "affiliation_type", "class_year"],
    }],
  }),
  "Arrays may be empty except phrasings, which needs 2-5 strings, and tags, which must include next_action.",
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
    let validationReason = "model returned an invalid rubric";
    let telemetry: LlmTelemetry | null = null;
    for (let planningAttempt = 0; planningAttempt < 3; planningAttempt++) {
      const repair = planningAttempt === 0 ? "" : `\n\nThe previous rubric failed validation: ${validationReason}. Return a corrected complete rubric.`;
      const response = await callStructuredJson({
        system: SYSTEM_PROMPT,
        user: `Query: ${cleanQuery}\n\nAvailable fields:\n${schema}${repair}`,
        model: options.model ?? DEFAULT_RUBRIC_PLANNER_MODEL,
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries,
      });
      telemetry = mergeTelemetry(telemetry, response.telemetry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.jsonText);
      } catch {
        validationReason = "model returned non-JSON";
        continue;
      }
      try {
        // IDs, versions, routes, and gate fallback behavior are operational
        // metadata. The model remains responsible for the fundraising fields,
        // criteria, weights, phrasings, and action descriptions.
        const normalized = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? normalizePlannerMetadata(parsed as Record<string, unknown>)
          : parsed;
        const rubric = validateCompiledRubric(normalized, availableFields);
        ensureGiveCampusActionTag(rubric);
        return { rubric, fallback: false, reason: null, telemetry };
      } catch (error) {
        validationReason = (error as Error).message;
      }
    }
    return { ...fallback(validationReason), telemetry };
  } catch (error) {
    return fallback((error as Error).message || "llm error");
  }
}

function mergeTelemetry(previous: LlmTelemetry | null, current: LlmTelemetry): LlmTelemetry {
  if (!previous) return current;
  const addNullable = (a: number | null, b: number | null) => a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return {
    model: current.model,
    inputTokens: previous.inputTokens + current.inputTokens,
    outputTokens: previous.outputTokens + current.outputTokens,
    latencyMs: previous.latencyMs + current.latencyMs,
    retries: previous.retries + current.retries,
    estimatedInputUsd: addNullable(previous.estimatedInputUsd, current.estimatedInputUsd),
    estimatedOutputUsd: addNullable(previous.estimatedOutputUsd, current.estimatedOutputUsd),
    estimatedTotalUsd: addNullable(previous.estimatedTotalUsd, current.estimatedTotalUsd),
  };
}

function normalizePlannerMetadata(parsed: Record<string, unknown>): Record<string, unknown> {
  const gates = Array.isArray(parsed.gates) ? parsed.gates.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const gate = { ...(raw as Record<string, unknown>) };
    if (typeof gate.threshold !== "number" || !Number.isFinite(gate.threshold) || gate.threshold < 0.5 || gate.threshold > 1) {
      gate.threshold = 0.7;
    }
    if (!["review", "downrank", "exclude"].includes(String(gate.unknownPolicy))) gate.unknownPolicy = "downrank";
    return gate;
  }) : parsed.gates;
  return { ...parsed, id: "givecampus-query-rubric", version: "luna-v1", route: "deep", gates };
}

function ensureGiveCampusActionTag(rubric: CompiledRubric): void {
  const tag = rubric.tags.find((candidate) => candidate.id === "next_action");
  const expected = ["ask", "event_invite", "reunion_mailer", "thank_you"];
  const actual = Object.keys(tag?.options ?? {}).sort();
  if (!tag || actual.length !== expected.length || actual.some((value, i) => value !== expected[i])) {
    throw new Error("next_action tag must contain exactly thank_you, event_invite, reunion_mailer, ask");
  }
}
