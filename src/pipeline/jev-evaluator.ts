import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Question } from "@typesafe-ai/sdk";
import { DATASET_VERSION } from "../config.js";
import { EVIDENCE_VERSION, MODEL_VERSION, sha256Hex, stableStringify } from "../givecampus/criterion.js";
import type { CachedQuestionAnswer, QuestionAnswerCache } from "./question-cache.js";

export const PIPELINE_FIELDS = [
  "city", "state", "affiliation_type", "class_year", "gift_recency_band", "gift_frequency_band",
  "giving_amount_band", "engagement_events", "interaction_summary", "career_change_band", "title",
  "employer", "contactability", "solicitation_fatigue_band",
] as const;

export type PipelineField = (typeof PIPELINE_FIELDS)[number];
export type FieldValue = string | number | boolean | null | Array<string | number | boolean | null>;

export interface GateCriterion {
  id: string;
  question: string;
  trueCriteria: string;
  falseCriteria: string;
  fields: PipelineField[];
  threshold: number;
  unknownPolicy: "review" | "downrank" | "exclude";
}

export interface ScoreCriterion {
  id: string;
  question: string;
  levels: [string, string, ...string[]];
  fields: PipelineField[];
  weight: number;
}

export interface BonusCriterion {
  id: string;
  question: string;
  trueCriteria: string;
  falseCriteria: string;
  fields: PipelineField[];
  weight: number;
}

export interface TagCriterion {
  id: string;
  question: string;
  options: Record<string, string>;
  fields: PipelineField[];
}

/** Structural contract matching the full rubric planned in the handoff. */
export interface DynamicRubric {
  id: string;
  version: string;
  gates: GateCriterion[];
  scores: ScoreCriterion[];
  bonuses: BonusCriterion[];
  tags: TagCriterion[];
}

export type DynamicQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: [string, string, ...string[]] }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export interface DynamicJevClient {
  systemOne(args: {
    state: Record<string, FieldValue>;
    questions: Record<string, DynamicQuestion>;
    model?: string;
  }): Promise<{
    model: string;
    answers: Record<string, Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
    retries?: number;
  }>;
}

/** Uses the pinned TypeSafe SDK/model; it accepts no client-side embeddings or retrieval metadata. */
export class TypesafeDynamicJevClient implements DynamicJevClient {
  private inner: TypeSafeClient | null = null;

  constructor(private readonly options: { apiKey?: string; baseURL?: string; timeoutMs?: number } = {}) {}

  private getClient(): TypeSafeClient {
    if (this.inner) return this.inner;
    const apiKey = this.options.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey?.trim()) throw new Error("TYPESAFE_API_KEY not configured");
    this.inner = new TypeSafeClient({
      apiKey,
      baseURL: this.options.baseURL ?? process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai",
      timeout: this.options.timeoutMs ?? 10_000,
      retry: {
        maxRetries: 2,
        httpStatuses: new Set([408, 429, 500, 502, 503, 504]),
        backoffInitialMs: 500,
        backoffMaxMs: 5000,
        backoffJitter: 0.25,
        respectRetryAfter: true,
        maxRetryAfterMs: 60_000,
      },
    });
    return this.inner;
  }

  async systemOne(args: {
    state: Record<string, FieldValue>;
    questions: Record<string, DynamicQuestion>;
    model?: string;
  }) {
    const t0 = Date.now();
    const res = await this.getClient().systemOne({
      state: args.state,
      questions: args.questions as unknown as Record<string, Question>,
      model: args.model ?? MODEL_VERSION,
    });
    void t0; // The SDK response does not expose its internal retry count.
    return {
      model: res.model,
      answers: res.answers as unknown as Record<string, Record<string, unknown>>,
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
      retries: 0,
    };
  }
}

export type CriterionKind = "gate" | "score" | "bonus" | "tag";
export type AnswerStatus = "pass" | "fail" | "unknown";

export interface CriterionAnswer {
  criterionId: string;
  kind: CriterionKind;
  status: AnswerStatus;
  /** Noul probability, normalized score, or selected Choice label. */
  value: number | string | null;
  rawAnswer: Record<string, unknown> | null;
  evidenceRefs: string[];
  missingFields: PipelineField[];
  cacheHit: boolean;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cachedInputTokens: number;
  cachedOutputTokens: number;
}

export interface CandidateRubricEvaluation {
  constituentId: number;
  gates: Record<string, CriterionAnswer>;
  scores: Record<string, CriterionAnswer>;
  bonuses: Record<string, CriterionAnswer>;
  tags: Record<string, CriterionAnswer>;
  disposition: "eligible" | "review" | "excluded";
  reviewReasons: string[];
  unknownDownrankCount: number;
  rubricScore: number | null;
  evidenceCompleteness: number;
}

export interface EvaluateCandidateOptions {
  constituentId: number;
  /** Values from the item card; only allowlisted fields named by each criterion are sent. */
  fields: Partial<Record<PipelineField, FieldValue>> & Record<string, unknown>;
  evidenceRefs?: Partial<Record<PipelineField, string[]>>;
  rubric: DynamicRubric;
  asOf: string;
  datasetVersion?: string;
  evidenceVersion?: string;
  model?: string;
  client?: DynamicJevClient;
  cache?: QuestionAnswerCache;
}

const FIELD_SET = new Set<string>(PIPELINE_FIELDS);

function validateFields(fields: PipelineField[]): void {
  if (!Array.isArray(fields) || fields.length === 0) throw new Error("Every Jev criterion needs at least one field");
  for (const field of fields) if (!FIELD_SET.has(field)) throw new Error(`Unsupported Jev field: ${String(field)}`);
}

function jsonFieldValue(value: unknown, field: string): FieldValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    Array.isArray(value) &&
    value.every((v) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))
  ) {
    return value as FieldValue;
  }
  throw new Error(`Jev field ${field} must be a raw scalar or scalar array`);
}

function scopedState(fields: Partial<Record<PipelineField, FieldValue>>, criterionFields: PipelineField[]): Record<string, FieldValue> {
  const state: Record<string, FieldValue> = {};
  for (const field of criterionFields) {
    const value = fields[field];
    if (value !== undefined) state[field] = jsonFieldValue(value, field);
  }
  return state;
}

function makeQuestion(kind: CriterionKind, criterion: GateCriterion | ScoreCriterion | BonusCriterion | TagCriterion): DynamicQuestion {
  if (kind === "gate" || kind === "bonus") {
    const c = criterion as GateCriterion | BonusCriterion;
    return { type: "noul", instructions: c.question, criteria: { true: c.trueCriteria, false: c.falseCriteria } };
  }
  if (kind === "score") {
    const c = criterion as ScoreCriterion;
    if (c.levels.length < 2 || c.levels.length > 4) throw new Error(`Score ${c.id} must have 2 to 4 levels`);
    return { type: "score", instructions: c.question, criteria: c.levels };
  }
  const c = criterion as TagCriterion;
  const options = Object.keys(c.options);
  if (options.length < 2 || options.length > 12) throw new Error(`Tag ${c.id} must have 2 to 12 options`);
  return { type: "choice", instructions: c.question, criteria: c.options };
}

function extractAnswer(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function noulValue(answer: Record<string, unknown> | null): number | null {
  const value = answer?.noul;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function scopedEvidence(fields: PipelineField[], refs: EvaluateCandidateOptions["evidenceRefs"]): string[] {
  const out = new Set<string>();
  for (const field of fields) for (const ref of refs?.[field] ?? []) if (typeof ref === "string") out.add(ref);
  return [...out];
}

function answerStatus(answer: Record<string, unknown> | null): AnswerStatus {
  return answer ? "pass" : "unknown";
}

async function evaluateOne(
  opts: EvaluateCandidateOptions,
  kind: CriterionKind,
  criterion: GateCriterion | ScoreCriterion | BonusCriterion | TagCriterion,
): Promise<CriterionAnswer> {
  validateFields(criterion.fields);
  const question = makeQuestion(kind, criterion);
  const state = scopedState(opts.fields, criterion.fields);
  const missingFields = criterion.fields.filter((f) => state[f] === undefined || state[f] === null);
  const evidenceRefs = scopedEvidence(criterion.fields, opts.evidenceRefs);
  const criterionKey = `${kind}:${criterion.id}`;
  // Empty states carry no evidence; treat these answers as unknown without asking Jev to guess.
  if (!Object.keys(state).some((f) => state[f] !== null)) {
    return {
      criterionId: criterion.id, kind, status: "unknown", value: null, rawAnswer: null,
      evidenceRefs, missingFields, cacheHit: false, model: null,
      inputTokens: 0, outputTokens: 0, latencyMs: 0, cachedInputTokens: 0, cachedOutputTokens: 0,
    };
  }

  const datasetVersion = opts.datasetVersion ?? DATASET_VERSION;
  const evidenceVersion = opts.evidenceVersion ?? EVIDENCE_VERSION;
  const model = opts.model ?? MODEL_VERSION;
  const questionHash = sha256Hex(stableStringify(question));
  const relevantStateHash = sha256Hex(stableStringify(state));
  const cacheKey = sha256Hex(stableStringify({
    constituentId: opts.constituentId, criterionKey, questionHash, relevantStateHash,
    datasetVersion, evidenceVersion, asOf: opts.asOf, model,
  }));
  const cached = opts.cache?.get(cacheKey);
  let answer: Record<string, unknown> | null;
  let responseModel: string;
  let inputTokens: number;
  let outputTokens: number;
  let latencyMs: number;
  let cachedInputTokens = 0;
  let cachedOutputTokens = 0;
  let cacheHit = false;

  if (cached?.hit) {
    answer = extractAnswer(cached.value.answer[criterionKey]);
    responseModel = cached.value.model;
    inputTokens = 0;
    outputTokens = 0;
    latencyMs = 0;
    cachedInputTokens = cached.value.inputTokens;
    cachedOutputTokens = cached.value.outputTokens;
    cacheHit = true;
  } else {
    const client = opts.client ?? new TypesafeDynamicJevClient();
    const startedAt = Date.now();
    const response = await client.systemOne({ state, questions: { [criterionKey]: question }, model });
    answer = extractAnswer(response.answers[criterionKey]);
    responseModel = response.model;
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
    latencyMs = Date.now() - startedAt;
    opts.cache?.set({
      cacheKey,
      constituentId: opts.constituentId,
      questionId: criterionKey,
      questionHash,
      relevantStateHash,
      datasetVersion,
      evidenceVersion,
      asOf: opts.asOf,
      model: response.model,
      value: {
        answer: { [criterionKey]: answer ?? {} },
        model: response.model,
        inputTokens,
        outputTokens,
        latencyMs,
      },
    });
  }

  const rawValue = question.type === "noul" ? noulValue(answer)
    : question.type === "score" ? (typeof answer?.score === "number" && Number.isFinite(answer.score) ? answer.score : null)
      : typeof answer?.choice === "string" ? answer.choice : null;
  let status = answerStatus(answer);
  let value: number | string | null = rawValue;
  if (question.type === "noul") status = rawValue === null ? "unknown" : "pass";
  else if (question.type === "score") {
    const max = question.criteria.length - 1;
    if (rawValue === null || (rawValue as number) < 0 || (rawValue as number) > max) {
      status = "unknown";
      value = null;
    } else value = (rawValue as number) / max;
  } else if (rawValue === null || !(rawValue in question.criteria)) {
    status = "unknown";
    value = null;
  }

  return {
    criterionId: criterion.id, kind, status, value, rawAnswer: answer, evidenceRefs, missingFields,
    cacheHit, model: responseModel, inputTokens, outputTokens, latencyMs, cachedInputTokens, cachedOutputTokens,
  };
}

function weightedKnownMean(items: CriterionAnswer[], criteria: ScoreCriterion[]): number | null {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const known = items.filter((x) => x.status !== "unknown" && typeof x.value === "number");
  const denominator = known.reduce((sum, x) => sum + Math.max(0, byId.get(x.criterionId)?.weight ?? 0), 0);
  if (denominator === 0) return null;
  const numerator = known.reduce((sum, x) => sum + (x.value as number) * Math.max(0, byId.get(x.criterionId)?.weight ?? 0), 0);
  return numerator / denominator;
}

function rubricScore(scores: CriterionAnswer[], bonuses: CriterionAnswer[], rubric: DynamicRubric): number | null {
  const base = weightedKnownMean(scores, rubric.scores);
  let bonus = 0;
  for (const result of bonuses) {
    const probability = noulValue(result.rawAnswer);
    if (probability !== null) bonus += Math.max(0, rubric.bonuses.find((b) => b.id === result.criterionId)?.weight ?? 0) * probability;
  }
  if (base === null && bonuses.every((b) => b.status === "unknown")) return null;
  return (base ?? 0) + bonus;
}

/** Evaluate independent gates first; evaluate scores/bonuses/tags only for gate survivors. */
export async function evaluateRubricForCandidate(opts: EvaluateCandidateOptions): Promise<CandidateRubricEvaluation> {
  const gates: Record<string, CriterionAnswer> = {};
  const scores: Record<string, CriterionAnswer> = {};
  const bonuses: Record<string, CriterionAnswer> = {};
  const tags: Record<string, CriterionAnswer> = {};
  const reviewReasons: string[] = [];
  let disposition: CandidateRubricEvaluation["disposition"] = "eligible";
  let unknownDownrankCount = 0;

  for (const criterion of opts.rubric.gates) {
    if (!Number.isFinite(criterion.threshold) || criterion.threshold < 0.5 || criterion.threshold > 1) {
      throw new Error(`Gate ${criterion.id} threshold must be between 0.5 and 1`);
    }
    const result = await evaluateOne(opts, "gate", criterion);
    const probability = noulValue(result.rawAnswer);
    result.status = probability === null ? "unknown"
      : probability >= criterion.threshold ? "pass"
        : probability <= 1 - criterion.threshold ? "fail" : "unknown";
    result.value = probability;
    gates[criterion.id] = result;

    if (result.status === "fail") {
      disposition = "excluded";
      reviewReasons.push(`gate_failed:${criterion.id}`);
    } else if (result.status === "unknown") {
      if (criterion.unknownPolicy === "exclude") {
        disposition = "excluded";
        reviewReasons.push(`gate_unknown_excluded:${criterion.id}`);
      } else if (criterion.unknownPolicy === "review") {
        if (disposition !== "excluded") disposition = "review";
        reviewReasons.push(`gate_unknown_review:${criterion.id}`);
      } else {
        unknownDownrankCount += 1;
      }
    }
  }

  const all = Object.values(gates);
  const knownGateCount = all.filter((g) => g.status !== "unknown").length;
  if (disposition !== "excluded" && disposition !== "review") {
    for (const criterion of opts.rubric.scores) scores[criterion.id] = await evaluateOne(opts, "score", criterion);
    for (const criterion of opts.rubric.bonuses) bonuses[criterion.id] = await evaluateOne(opts, "bonus", criterion);
    for (const criterion of opts.rubric.tags) tags[criterion.id] = await evaluateOne(opts, "tag", criterion);
  }
  const answerCount = all.length + Object.keys(scores).length + Object.keys(bonuses).length + Object.keys(tags).length;
  const knownAnswerCount = [...all, ...Object.values(scores), ...Object.values(bonuses), ...Object.values(tags)]
    .filter((x) => x.status !== "unknown").length;

  return {
    constituentId: opts.constituentId,
    gates, scores, bonuses, tags, disposition, reviewReasons, unknownDownrankCount,
    rubricScore: disposition === "eligible" ? rubricScore(Object.values(scores), Object.values(bonuses), opts.rubric) : null,
    evidenceCompleteness: answerCount === 0 ? (knownGateCount === all.length ? 1 : 0) : knownAnswerCount / answerCount,
  };
}

/** Candidate-level concurrency keeps each person's question states isolated. */
export async function evaluateRubricForCandidates(
  candidates: Omit<EvaluateCandidateOptions, "rubric">[],
  shared: Omit<EvaluateCandidateOptions, "constituentId" | "fields" | "evidenceRefs"> & {
    concurrency?: number;
  },
): Promise<CandidateRubricEvaluation[]> {
  const concurrency = Math.max(1, Math.min(8, Math.floor(shared.concurrency ?? 4)));
  const results = new Array<CandidateRubricEvaluation>(candidates.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= candidates.length) return;
      results[i] = await evaluateRubricForCandidate({ ...shared, ...candidates[i] });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  return results;
}
