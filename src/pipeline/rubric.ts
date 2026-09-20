/** Canonical rubric contract used by retrieval and the dynamic Jev pipeline.
 *
 * Retrieval phrasings are plain query text. Embeddings and semantic scores are
 * intentionally absent from this contract; semantic search only selects a
 * candidate pool, while Jev receives only the raw fields named by a criterion.
 */

export const FIELD_NAMES = [
  "city",
  "state",
  "affiliation_type",
  "class_year",
  "gift_recency_band",
  "gift_frequency_band",
  "giving_amount_band",
  "engagement_events",
  "interaction_summary",
  "career_change_band",
  "title",
  "employer",
  "contactability",
  "solicitation_fatigue_band",
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];
export const FILTER_OPS = ["eq", "neq", "gte", "lte", "gt", "lt", "contains", "in", "between"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export type FilterValue = string | number | boolean | null | Array<string | number>;
export type RubricRoute = "lookup" | "simple" | "deep" | "analysis";

export interface TypedFilter {
  field: FieldName;
  op: FilterOp;
  value: FilterValue;
}

export interface GateCriterion {
  id: string;
  question: string;
  trueCriteria: string;
  falseCriteria: string;
  fields: FieldName[];
  threshold: number;
  unknownPolicy: "review" | "downrank" | "exclude";
}

export interface ScoreCriterion {
  id: string;
  question: string;
  levels: [string, string, ...string[]];
  fields: FieldName[];
  weight: number;
}

export interface BonusCriterion {
  id: string;
  question: string;
  trueCriteria: string;
  falseCriteria: string;
  fields: FieldName[];
  weight: number;
}

export interface TagCriterion {
  id: string;
  question: string;
  options: Record<string, string>;
  fields: FieldName[];
}

export interface CompiledRubric {
  id: string;
  version: string;
  route: RubricRoute;
  filters: TypedFilter[];
  phrasings: string[];
  gates: GateCriterion[];
  scores: ScoreCriterion[];
  bonuses: BonusCriterion[];
  tags: TagCriterion[];
}

export type AvailableRubricField = string | { name: string; kind?: string };

const EXECUTABLE_TOKENS = ["select ", "where ", "drop ", "delete ", ";--", "/*", "*/", "union ", "insert ", "update ", "alter ", "truncate "];
const ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const NEGATIVE_QUESTION_RE = /\b(?:not|never|without|lack(?:ing)?|no)\b|n['’]t\b/i;
const NUMERIC_OR_DATE_INSTRUCTION_RE = /(?:[<>]=?|==|!=)\s*\d|\b(?:at least|at most|more than|less than|greater than|fewer than|within|before|after|since|older than|newer than|no later than|on or after|on or before)\b|\b\d{1,4}(?:-\d{1,2}(?:-\d{1,2})?)?\b/i;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`invalid ${label}`);
  const lower = value.toLowerCase();
  if (EXECUTABLE_TOKENS.some((token) => {
    const trimmed = token.trim();
    return trimmed.startsWith(";") || trimmed.startsWith("/*") || trimmed.startsWith("*/")
      ? lower.includes(trimmed)
      : new RegExp(`(?:^|\\s)${trimmed}(?:\\s|$)`, "i").test(lower);
  })) throw new Error(`executable fragment in ${label}`);
  return value.trim();
}

function criterionQuestion(value: unknown, label: string): string {
  const question = text(value, label, 220);
  if (NEGATIVE_QUESTION_RE.test(question)) throw new Error(`negative ${label}`);
  if (NUMERIC_OR_DATE_INSTRUCTION_RE.test(question)) throw new Error(`direct numeric/date comparison in ${label}`);
  if (!question.includes("?")) throw new Error(`${label} must be phrased as a question`);
  return question;
}

function plainFilterValue(value: unknown, field: string): FilterValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`invalid clause value for field ${field}`);
    return value;
  }
  if (typeof value === "string") return text(value, `filter value for ${field}`, 120);
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > 20 || !value.every((item) => typeof item === "string" || (typeof item === "number" && Number.isFinite(item)))) {
      throw new Error(`invalid clause value for field ${field}`);
    }
    return value.map((item) => typeof item === "string" ? text(item, `filter value for ${field}`, 120) : item);
  }
  throw new Error(`invalid clause value for field ${field}`);
}

function filterValueMatchesOp(op: FilterOp, value: FilterValue): boolean {
  if (op === "in") return Array.isArray(value);
  if (op === "between") return Array.isArray(value) && value.length === 2;
  if (Array.isArray(value)) return false;
  if (op === "contains") return typeof value === "string";
  return true;
}

function fieldList(value: unknown, allowed: Set<string>, label: string): FieldName[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > FIELD_NAMES.length) throw new Error(`invalid ${label}`);
  const seen = new Set<FieldName>();
  for (const field of value) {
    if (typeof field !== "string" || !allowed.has(field) || !FIELD_NAMES.includes(field as FieldName)) {
      throw new Error(`disallowed field in ${label}: ${String(field)}`);
    }
    seen.add(field as FieldName);
  }
  return [...seen];
}

function criterionId(value: unknown, seen: Set<string>): string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`invalid criterion id: ${String(value)}`);
  if (seen.has(value)) throw new Error(`duplicate criterion id: ${value}`);
  seen.add(value);
  return value;
}

function weight(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000) throw new Error(`invalid ${label} weight`);
  return value;
}

function normalize(values: Array<{ weight: number }>): void {
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  if (total > 0) for (const item of values) item.weight /= total;
}

/** Normalize score and bonus weights separately, preserving their relative roles. */
export function normalizeRubricWeights<T extends CompiledRubric>(rubric: T): T {
  const normalized = structuredClone(rubric);
  normalize(normalized.scores);
  normalize(normalized.bonuses);
  return normalized;
}

/**
 * Validate and sanitize a full rubric. `availableFields` must describe the
 * fields supported by the active dataset; the contract allowlist is intersected
 * with that schema before any clause or Jev field scope is accepted.
 */
export function validateCompiledRubric(input: unknown, availableFields: readonly AvailableRubricField[]): CompiledRubric {
  if (!Array.isArray(availableFields) || availableFields.length === 0 || availableFields.length > 64) {
    throw new Error("invalid available-field schema");
  }
  const available = new Set(availableFields.map((field) => typeof field === "string" ? field : field.name));
  const allowed = new Set<string>(FIELD_NAMES.filter((field) => available.has(field)));
  const o = record(input, "rubric");
  exactKeys(o, ["id", "version", "route", "filters", "phrasings", "gates", "scores", "bonuses", "tags"], "rubric");

  const id = text(o.id, "rubric id", 80);
  const version = text(o.version, "rubric version", 40);
  if (typeof o.route !== "string" || !["lookup", "simple", "deep", "analysis"].includes(o.route)) throw new Error(`invalid route: ${String(o.route)}`);

  if (!Array.isArray(o.filters) || o.filters.length > 12) throw new Error("rubric.filters must contain at most 12 filters");
  const filters = o.filters.map((raw, index): TypedFilter => {
    const clause = record(raw, `filter ${index}`);
    exactKeys(clause, ["field", "op", "value"], `filter ${index}`);
    if (typeof clause.field !== "string" || !allowed.has(clause.field)) throw new Error(`disallowed field: ${String(clause.field)}`);
    if (typeof clause.op !== "string" || !FILTER_OPS.includes(clause.op as FilterOp)) throw new Error(`disallowed op: ${String(clause.op)}`);
    const op = clause.op as FilterOp;
    const value = plainFilterValue(clause.value, clause.field);
    if (!filterValueMatchesOp(op, value)) throw new Error(`invalid value for ${op} filter on ${clause.field}`);
    return { field: clause.field as FieldName, op, value };
  });

  if (!Array.isArray(o.phrasings) || o.phrasings.length < 2 || o.phrasings.length > 5) throw new Error("rubric.phrasings must contain 2 to 5 retrieval phrases");
  const phrasings = o.phrasings.map((phrase, i) => text(phrase, `retrieval phrasing ${i}`, 400));

  const ids = new Set<string>();
  const gates = boundedArray(o.gates, 6, "gates").map((raw, index): GateCriterion => {
    const item = record(raw, `gate ${index}`);
    exactKeys(item, ["id", "question", "trueCriteria", "falseCriteria", "fields", "threshold", "unknownPolicy"], `gate ${index}`);
    if (typeof item.threshold !== "number" || !Number.isFinite(item.threshold) || item.threshold < 0 || item.threshold > 1) throw new Error(`invalid gate threshold: ${String(item.threshold)}`);
    if (!["review", "downrank", "exclude"].includes(String(item.unknownPolicy))) throw new Error(`invalid gate unknownPolicy: ${String(item.unknownPolicy)}`);
    const trueCriteria = text(item.trueCriteria, `gate ${index} trueCriteria`, 240);
    const falseCriteria = text(item.falseCriteria, `gate ${index} falseCriteria`, 240);
    if (NUMERIC_OR_DATE_INSTRUCTION_RE.test(trueCriteria) || NUMERIC_OR_DATE_INSTRUCTION_RE.test(falseCriteria)) throw new Error(`direct numeric/date comparison in gate ${index} criteria`);
    return {
      id: criterionId(item.id, ids), question: criterionQuestion(item.question, `gate ${index} question`),
      trueCriteria, falseCriteria, fields: fieldList(item.fields, allowed, `gate ${index} fields`),
      threshold: item.threshold, unknownPolicy: item.unknownPolicy as GateCriterion["unknownPolicy"],
    };
  });

  const scores = boundedArray(o.scores, 6, "scores").map((raw, index): ScoreCriterion => {
    const item = record(raw, `score ${index}`);
    exactKeys(item, ["id", "question", "levels", "fields", "weight"], `score ${index}`);
    if (!Array.isArray(item.levels) || item.levels.length < 2 || item.levels.length > 4) throw new Error(`score ${index} must have 2 to 4 ordered levels`);
    const levels = item.levels.map((level, i) => text(level, `score ${index} level ${i}`, 200));
    if (levels.some((level) => NUMERIC_OR_DATE_INSTRUCTION_RE.test(level))) throw new Error(`direct numeric/date comparison in score ${index} levels`);
    return {
      id: criterionId(item.id, ids), question: criterionQuestion(item.question, `score ${index} question`),
      levels: levels as [string, string, ...string[]], fields: fieldList(item.fields, allowed, `score ${index} fields`),
      weight: weight(item.weight, `score ${index}`),
    };
  });

  const bonuses = boundedArray(o.bonuses, 4, "bonuses").map((raw, index): BonusCriterion => {
    const item = record(raw, `bonus ${index}`);
    exactKeys(item, ["id", "question", "trueCriteria", "falseCriteria", "fields", "weight"], `bonus ${index}`);
    const trueCriteria = text(item.trueCriteria, `bonus ${index} trueCriteria`, 240);
    const falseCriteria = text(item.falseCriteria, `bonus ${index} falseCriteria`, 240);
    if (NUMERIC_OR_DATE_INSTRUCTION_RE.test(trueCriteria) || NUMERIC_OR_DATE_INSTRUCTION_RE.test(falseCriteria)) throw new Error(`direct numeric/date comparison in bonus ${index} criteria`);
    return {
      id: criterionId(item.id, ids), question: criterionQuestion(item.question, `bonus ${index} question`),
      trueCriteria, falseCriteria, fields: fieldList(item.fields, allowed, `bonus ${index} fields`),
      weight: weight(item.weight, `bonus ${index}`),
    };
  });

  const tags = boundedArray(o.tags, 4, "tags").map((raw, index): TagCriterion => {
    const item = record(raw, `tag ${index}`);
    exactKeys(item, ["id", "question", "options", "fields"], `tag ${index}`);
    const rawOptions = record(item.options, `tag ${index} options`);
    const entries = Object.entries(rawOptions);
    if (entries.length < 2 || entries.length > 12) throw new Error(`tag ${index} must have 2 to 12 options`);
    const options: Record<string, string> = {};
    for (const [key, description] of entries) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(key)) throw new Error(`invalid tag ${index} option key: ${key}`);
      options[key] = text(description, `tag ${index} option ${key}`, 200);
    }
    return {
      id: criterionId(item.id, ids), question: criterionQuestion(item.question, `tag ${index} question`),
      options, fields: fieldList(item.fields, allowed, `tag ${index} fields`),
    };
  });

  return normalizeRubricWeights({ id, version, route: o.route as RubricRoute, filters, phrasings, gates, scores, bonuses, tags });
}

function boundedArray(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`rubric.${label} must contain at most ${max} criteria`);
  return value;
}

/** Generic fail-closed rubric for pipeline callers; no Jev judgment is implied. */
export const DEFAULT_COMPILED_RUBRIC: CompiledRubric = {
  id: "safe-default",
  version: "pipeline-v1",
  route: "deep",
  filters: [],
  phrasings: ["GiveCampus constituent matching the requested criteria", "Relevant alumni giving and engagement context"],
  gates: [],
  scores: [],
  bonuses: [],
  tags: [],
};

/** Safe GiveCampus fallback used when rubric compilation is unavailable. */
export const DEFAULT_GIVECAMPUS_RUBRIC: CompiledRubric = normalizeRubricWeights({
  id: "givecampus-outreach",
  version: "pipeline-v1",
  route: "deep",
  filters: [{ field: "contactability", op: "neq", value: "none recorded" }],
  phrasings: [
    "alumni donor engagement and giving-day outreach",
    "constituent relationship giving history events and reunion affinity",
  ],
  gates: [],
  scores: [{
    id: "relationship_strength",
    question: "How strong is this constituent's demonstrated relationship with the school?",
    levels: ["Little relationship evidence", "Some relationship evidence", "Regular relationship evidence", "Strong sustained relationship evidence"],
    fields: ["gift_frequency_band", "engagement_events", "interaction_summary"],
    weight: 1,
  }],
  bonuses: [{
    id: "timely_signal",
    question: "Does the record show a timely reason for personal outreach?",
    trueCriteria: "The provided engagement or career band shows a timely outreach signal",
    falseCriteria: "The provided fields show no timely outreach signal",
    fields: ["career_change_band", "interaction_summary"],
    weight: 1,
  }],
  tags: [{
    id: "next_action",
    question: "Which single fundraising action best fits this constituent now?",
    options: {
      thank_you: "A stewardship thank-you best matches the recent giving relationship",
      event_invite: "An event invitation best matches current affinity and location",
      reunion_mailer: "A reunion mailer best matches the alumni and class-year context",
      ask: "A direct fundraising ask is appropriate given the giving and engagement evidence",
    },
    fields: [
      "gift_recency_band", "gift_frequency_band", "giving_amount_band", "engagement_events",
      "interaction_summary", "affiliation_type", "class_year", "city", "state",
      "contactability", "solicitation_fatigue_band",
    ],
  }],
});
