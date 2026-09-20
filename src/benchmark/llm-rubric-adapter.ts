import type { FetchFn } from "../llm/client.js";
import { DATASET_VERSION } from "../config.js";
import { EVIDENCE_VERSION, MODEL_VERSION, sha256Hex, stableStringify } from "../givecampus/criterion.js";
import type {
  BonusCriterion,
  DynamicRubric,
  FieldValue,
  GateCriterion,
  PipelineField,
  ScoreCriterion,
  TagCriterion,
} from "../pipeline/jev-evaluator.js";

export const FUNDRAISING_ACTIONS = ["thank_you", "event_invite", "reunion_mailer", "ask"] as const;
export type FundraisingAction = (typeof FUNDRAISING_ACTIONS)[number];

export interface LlmRubricCacheValue {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** Small injectable cache contract so a benchmark can compare cold and warm runs. */
export interface LlmRubricCache {
  get(key: string): LlmRubricCacheValue | undefined;
  set(key: string, value: LlmRubricCacheValue): void;
}

export class MapLlmRubricCache implements LlmRubricCache {
  private readonly values = new Map<string, LlmRubricCacheValue>();
  hits = 0;
  misses = 0;
  writes = 0;

  get(key: string): LlmRubricCacheValue | undefined {
    const value = this.values.get(key);
    if (value) this.hits += 1;
    else this.misses += 1;
    return value ? structuredClone(value) : undefined;
  }

  set(key: string, value: LlmRubricCacheValue): void {
    this.values.set(key, structuredClone(value));
    this.writes += 1;
  }
}

export interface LlmRubricTelemetry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retries: number;
  cacheHit: boolean;
  cachedInputTokens: number;
  cachedOutputTokens: number;
  estimatedCostUsd: number | null;
}

export interface LlmCriterionResult {
  kind: "gate" | "score" | "bonus" | "tag";
  status: "pass" | "fail" | "unknown";
  value: number | string | null;
  rawAnswer: Record<string, unknown> | null;
}

export interface LlmRubricCandidateResult {
  candidateId: number | string;
  disposition: "eligible" | "review" | "excluded";
  rubricScore: number | null;
  action: FundraisingAction | null;
  criteria: Record<string, LlmCriterionResult>;
  telemetry: LlmRubricTelemetry;
}

export interface LlmRubricCandidate {
  candidateId: number | string;
  /** Only rubric fields are projected; extra runtime properties are ignored. */
  fields: Partial<Record<PipelineField, FieldValue>> & Record<string, unknown>;
}

export interface LlmRubricAdapterOptions {
  fetchFn?: FetchFn;
  cache?: LlmRubricCache;
  apiKey?: string;
  url?: string;
  model?: string;
  timeoutMs?: number;
  datasetVersion?: string;
  evidenceVersion?: string;
  inputUsdPerMtok?: number;
  outputUsdPerMtok?: number;
  actionCriterionId?: string;
}

interface ScopedQuestionInput {
  id: string;
  kind: "gate" | "score" | "bonus" | "tag";
  question: string;
  criteria: Record<string, string> | string[];
  state: Record<string, FieldValue>;
}

const FIELD_SET = new Set<string>([
  "city", "state", "affiliation_type", "class_year", "gift_recency_band", "gift_frequency_band",
  "giving_amount_band", "engagement_events", "interaction_summary", "career_change_band", "title",
  "employer", "contactability", "solicitation_fatigue_band",
]);

function safeFieldValue(value: unknown, field: string): FieldValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((part) =>
    part === null || typeof part === "string" || typeof part === "boolean" ||
    (typeof part === "number" && Number.isFinite(part)))) return value as FieldValue;
  throw new Error(`Rubric field ${field} must be a raw scalar or scalar array`);
}

function questionInput(
  kind: ScopedQuestionInput["kind"],
  criterion: GateCriterion | ScoreCriterion | BonusCriterion | TagCriterion,
  fields: LlmRubricCandidate["fields"],
): ScopedQuestionInput {
  if (!Array.isArray(criterion.fields) || criterion.fields.length === 0) {
    throw new Error(`Criterion ${criterion.id} needs at least one field`);
  }
  const state: Record<string, FieldValue> = {};
  for (const field of criterion.fields) {
    if (!FIELD_SET.has(field)) throw new Error(`Unsupported rubric field: ${String(field)}`);
    const value = fields[field];
    if (value !== undefined) state[field] = safeFieldValue(value, field);
  }
  const base = { id: `${kind}:${criterion.id}`, kind, question: criterion.question, state };
  if (kind === "gate" || kind === "bonus") {
    const c = criterion as GateCriterion | BonusCriterion;
    return { ...base, criteria: { true: c.trueCriteria, false: c.falseCriteria } };
  }
  if (kind === "score") {
    const levels = (criterion as ScoreCriterion).levels;
    if (levels.length < 2 || levels.length > 4) throw new Error(`Score ${criterion.id} needs 2 to 4 levels`);
    return { ...base, criteria: [...levels] };
  }
  const options = (criterion as TagCriterion).options;
  if (Object.keys(options).length < 2 || Object.keys(options).length > 12) {
    throw new Error(`Tag ${criterion.id} needs 2 to 12 options`);
  }
  return { ...base, criteria: { ...options } };
}

/** Public pure projection, intentionally identical to Jev's per-criterion field scope. */
export function buildLlmRubricInputs(
  fields: LlmRubricCandidate["fields"],
  rubric: DynamicRubric,
): ScopedQuestionInput[] {
  return [
    ...rubric.gates.map((criterion) => questionInput("gate", criterion, fields)),
    ...rubric.scores.map((criterion) => questionInput("score", criterion, fields)),
    ...rubric.bonuses.map((criterion) => questionInput("bonus", criterion, fields)),
    ...rubric.tags.map((criterion) => questionInput("tag", criterion, fields)),
  ];
}

function responseText(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  const out: string[] = [];
  if (Array.isArray(record.output)) for (const item of record.output) {
    if (item === null || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part !== null && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if ((p.type === "output_text" || p.type === "text") && typeof p.text === "string") out.push(p.text);
      }
    }
  }
  return out.join("");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function answerRecord(value: unknown): Record<string, unknown> | null {
  return asRecord(value);
}

function finite01(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function finiteScore(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

function costEstimate(inputTokens: number, outputTokens: number, opts: LlmRubricAdapterOptions): number | null {
  const inputRate = opts.inputUsdPerMtok;
  const outputRate = opts.outputUsdPerMtok;
  if (inputRate === undefined && outputRate === undefined) return null;
  return ((inputRate ?? 0) * inputTokens + (outputRate ?? 0) * outputTokens) / 1_000_000;
}

function deriveResult(args: {
  candidateId: number | string;
  rubric: DynamicRubric;
  answers: Record<string, Record<string, unknown>>;
  telemetry: LlmRubricTelemetry;
  actionCriterionId: string;
}): LlmRubricCandidateResult {
  const criteria: Record<string, LlmCriterionResult> = {};
  let disposition: LlmRubricCandidateResult["disposition"] = "eligible";
  let knownScoreWeight = 0;
  let weightedScore = 0;
  let bonusTotal = 0;

  for (const criterion of args.rubric.gates) {
    const id = `gate:${criterion.id}`;
    const rawAnswer = answerRecord(args.answers[id]);
    const probability = finite01(rawAnswer?.noul);
    const status = probability === null ? "unknown"
      : probability >= criterion.threshold ? "pass"
        : probability <= 1 - criterion.threshold ? "fail" : "unknown";
    criteria[id] = { kind: "gate", status, value: probability, rawAnswer };
    if (status === "fail") disposition = "excluded";
    else if (status === "unknown" && criterion.unknownPolicy !== "downrank" && disposition !== "excluded") {
      disposition = criterion.unknownPolicy === "exclude" ? "excluded" : "review";
    }
  }

  for (const criterion of args.rubric.scores) {
    const id = `score:${criterion.id}`;
    const rawAnswer = answerRecord(args.answers[id]);
    const score = finiteScore(rawAnswer?.score, criterion.levels.length - 1);
    criteria[id] = { kind: "score", status: score === null ? "unknown" : "pass", value: score === null ? null : score / (criterion.levels.length - 1), rawAnswer };
    if (score !== null && criterion.weight > 0) {
      knownScoreWeight += criterion.weight;
      weightedScore += (score / (criterion.levels.length - 1)) * criterion.weight;
    }
  }

  for (const criterion of args.rubric.bonuses) {
    const id = `bonus:${criterion.id}`;
    const rawAnswer = answerRecord(args.answers[id]);
    const probability = finite01(rawAnswer?.noul);
    criteria[id] = { kind: "bonus", status: probability === null ? "unknown" : "pass", value: probability, rawAnswer };
    if (probability !== null && criterion.weight > 0) bonusTotal += criterion.weight * probability;
  }

  let action: FundraisingAction | null = null;
  for (const criterion of args.rubric.tags) {
    const id = `tag:${criterion.id}`;
    const rawAnswer = answerRecord(args.answers[id]);
    const choice = typeof rawAnswer?.choice === "string" && rawAnswer.choice in criterion.options ? rawAnswer.choice : null;
    criteria[id] = { kind: "tag", status: choice === null ? "unknown" : "pass", value: choice, rawAnswer };
    if (criterion.id === args.actionCriterionId && choice && FUNDRAISING_ACTIONS.includes(choice as FundraisingAction)) {
      action = choice as FundraisingAction;
    }
  }

  return {
    candidateId: args.candidateId,
    disposition,
    rubricScore: disposition === "eligible" && (knownScoreWeight > 0 || args.rubric.bonuses.length > 0)
      ? (knownScoreWeight > 0 ? weightedScore / knownScoreWeight : 0) + bonusTotal
      : null,
    action,
    criteria,
    telemetry: args.telemetry,
  };
}

/**
 * Evaluate one candidate with the same rubric fields and question scopes as Jev.
 * Candidate identity, retrieval metadata, embeddings, and semantic scores never
 * enter the request. Each call carries exactly one candidate's scoped states.
 */
export async function evaluateLlmRubricCandidate(args: {
  candidate: LlmRubricCandidate;
  rubric: DynamicRubric;
  asOf: string;
  options?: LlmRubricAdapterOptions;
}): Promise<LlmRubricCandidateResult> {
  const options = args.options ?? {};
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const questions = buildLlmRubricInputs(args.candidate.fields, args.rubric);
  const payloadForModel = {
    asOf: args.asOf,
    questions,
    responseShape: {
      answers: Object.fromEntries(questions.map((question) => [question.id,
        question.kind === "gate" || question.kind === "bonus" ? { noul: "number from 0 to 1" }
          : question.kind === "score" ? { score: "integer from 0 to last rubric level" }
            : { choice: "one exact rubric option key" },
      ])),
    },
  };
  const cacheKey = sha256Hex(stableStringify({
    candidateId: args.candidate.candidateId,
    rubricId: args.rubric.id,
    rubricVersion: args.rubric.version,
    questions,
    asOf: args.asOf,
    datasetVersion: options.datasetVersion ?? DATASET_VERSION,
    evidenceVersion: options.evidenceVersion ?? EVIDENCE_VERSION,
    model,
  }));
  const cached = options.cache?.get(cacheKey);
  if (cached) {
    return deriveResult({
      candidateId: args.candidate.candidateId,
      rubric: args.rubric,
      answers: cached.answers,
      actionCriterionId: options.actionCriterionId ?? "next_action",
      telemetry: {
        model: cached.model,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        retries: 0,
        cacheHit: true,
        cachedInputTokens: cached.inputTokens,
        cachedOutputTokens: cached.outputTokens,
        estimatedCostUsd: 0,
      },
    });
  }

  const fetchFn = options.fetchFn ?? fetch;
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) throw new Error("OPENAI_API_KEY not configured");
  const url = options.url ?? "https://api.openai.com/v1/responses";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const start = Date.now();
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: "Evaluate each fundraising rubric question independently using only the raw state included with that question. Do not infer unlisted evidence. Return one JSON object with an answers object keyed by question id. For noul answers return a confidence from 0 to 1, for score answers return an integer index into the ordered levels, and for choice answers return an exact option key." }] },
          { role: "user", content: [{ type: "input_text", text: JSON.stringify(payloadForModel) }] },
        ],
        text: { format: { type: "json_object" } },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`LLM rubric request failed (${response.status})`);
  const body = await response.json() as Record<string, unknown>;
  const text = responseText(body);
  if (!text.trim()) throw new Error("empty JSON output from LLM rubric request");
  const parsed = asRecord(JSON.parse(text));
  const answers = asRecord(parsed?.answers);
  if (!answers) throw new Error("LLM rubric response is missing answers");
  const normalizedAnswers: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(answers)) {
    const answer = asRecord(value);
    if (answer) normalizedAnswers[key] = answer;
  }
  const usage = asRecord(body.usage);
  const inputTokens = Number(usage?.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage?.output_tokens ?? 0) || 0;
  const latencyMs = Date.now() - start;
  const cacheValue: LlmRubricCacheValue = {
    model: typeof body.model === "string" ? body.model : model,
    answers: normalizedAnswers,
    inputTokens,
    outputTokens,
    latencyMs,
  };
  options.cache?.set(cacheKey, cacheValue);
  return deriveResult({
    candidateId: args.candidate.candidateId,
    rubric: args.rubric,
    answers: normalizedAnswers,
    actionCriterionId: options.actionCriterionId ?? "next_action",
    telemetry: {
      model: cacheValue.model,
      inputTokens,
      outputTokens,
      latencyMs,
      retries: 0,
      cacheHit: false,
      cachedInputTokens: 0,
      cachedOutputTokens: 0,
      estimatedCostUsd: costEstimate(inputTokens, outputTokens, options),
    },
  });
}
