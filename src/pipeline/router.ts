import { TypeSafeClient } from "@typesafe-ai/sdk";
import { MODEL_VERSION } from "../givecampus/criterion.js";
import type { RubricRoute } from "./rubric.js";

export interface RouteDecision {
  route: RubricRoute;
  confidence: number;
  wantsAll: boolean;
  hasNumber: boolean;
  reason: string;
}

export interface RouteClassifierResult {
  route: RubricRoute;
  confidence: number;
  wantsAll?: boolean;
  hasNumber?: boolean;
  reason?: string;
}

export interface RouteClassifier {
  classify(query: string): Promise<RouteClassifierResult>;
}

const ROUTES: RubricRoute[] = ["lookup", "simple", "deep", "analysis"];

/** One small JEV request over the query only. Candidate records never enter this classifier. */
export class TypesafeRouteClassifier implements RouteClassifier {
  private client: TypeSafeClient | null = null;

  constructor(private readonly options: { apiKey?: string; baseURL?: string; model?: string } = {}) {}

  async classify(query: string): Promise<RouteClassifierResult> {
    const key = this.options.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!key?.trim()) throw new Error("TYPESAFE_API_KEY not configured");
    this.client ??= new TypeSafeClient({
      apiKey: key,
      baseURL: this.options.baseURL ?? process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai",
      timeout: 10_000,
      retry: { maxRetries: 2 },
    });
    const result = await this.client.systemOne({
      state: { query: query.slice(0, 2000) },
      questions: {
        route: {
          type: "choice",
          instructions: "Which execution path does this fundraising query need?",
          criteria: {
            lookup: "Direct lookup of a named constituent or exact identifier",
            simple: "Keyword or single-field retrieval without judgment",
            deep: "Multiple constraints or judgment requiring a rubric",
            analysis: "Group summary, segmentation, distribution, or aggregate analysis",
          },
        },
        wants_all: {
          type: "noul",
          instructions: "Does the query explicitly request all matching constituents?",
          criteria: { true: "Explicitly requests all or every match", false: "Requests a shortlist or leaves count open" },
        },
        has_number: {
          type: "noul",
          instructions: "Does the query include an explicit numeric value?",
          criteria: { true: "Contains an explicit numeric value", false: "Contains no explicit numeric value" },
        },
      },
      model: this.options.model ?? MODEL_VERSION,
    });
    const route = result.answers.route.choice as RubricRoute;
    return {
      route: ROUTES.includes(route) ? route : "deep",
      confidence: result.answers.route.confidence,
      wantsAll: result.answers.wants_all.noul >= 0.5,
      hasNumber: result.answers.has_number.noul >= 0.5,
      reason: "JEV query-route classification",
    };
  }
}

export function deterministicRoute(query: string): RouteDecision {
  const normalized = query.trim().toLowerCase();
  const wantsAll = /\b(?:all|every|everyone|entire|whole)\b/.test(normalized);
  const hasNumber = /(?:^|\s|[$#])\d+(?:[,.]\d+)*(?:\b|%)/.test(normalized);
  if (/\b(?:summarize|segment|segments|group|groups|distribution|breakdown|what does .* look like|count by)\b/.test(normalized)) {
    return { route: "analysis", confidence: 0.9, wantsAll, hasNumber, reason: "aggregate or group-analysis language" };
  }
  if (/\b(?:id|constituent)\s*[:#]?\s*\d+\b/.test(normalized)) {
    return { route: "lookup", confidence: 0.86, wantsAll, hasNumber, reason: "direct identifier or name lookup" };
  }
  const constraintCount = [
    /\b(?:and|but|except|while|who)\b/, /\b(?:recent|lapsed|loyal|consistent|meaningful|ready|likely|should)\b/,
    /\b(?:not|without|missing|exclude|avoid)\b/, /\b(?:gift|donor|engagement|career|solicit|reunion|contact)\b/,
  ].filter((pattern) => pattern.test(normalized)).length;
  if (constraintCount >= 2) {
    return { route: "deep", confidence: 0.82, wantsAll, hasNumber, reason: "multiple constraints or judgment terms" };
  }
  if (/^(?:find|show|lookup|look up)\s+[a-z'’-]+\s+[a-z'’-]+[?.!]*$/.test(normalized)) {
    return { route: "lookup", confidence: 0.86, wantsAll, hasNumber, reason: "direct identifier or name lookup" };
  }
  return { route: "simple", confidence: normalized ? 0.76 : 0.51, wantsAll, hasNumber, reason: "single retrieval intent" };
}

export async function routeQuery(
  query: string,
  options: { classifier?: RouteClassifier; confidenceFloor?: number } = {},
): Promise<RouteDecision> {
  const fallback = deterministicRoute(query);
  if (!options.classifier) return fallback;
  try {
    const answer = await options.classifier.classify(query.slice(0, 2000));
    const confidence = Number.isFinite(answer.confidence) ? Math.max(0, Math.min(1, answer.confidence)) : 0;
    const route = confidence < (options.confidenceFloor ?? 0.65) ? oneLevelDeeper(answer.route) : answer.route;
    return {
      route,
      confidence,
      wantsAll: answer.wantsAll ?? fallback.wantsAll,
      hasNumber: answer.hasNumber ?? fallback.hasNumber,
      reason: confidence < (options.confidenceFloor ?? 0.65)
        ? `low-confidence ${answer.route} escalated to ${route}`
        : answer.reason ?? "JEV query-route classification",
    };
  } catch {
    return { ...fallback, reason: `${fallback.reason}; deterministic fallback` };
  }
}

function oneLevelDeeper(route: RubricRoute): RubricRoute {
  const index = ROUTES.indexOf(route);
  return ROUTES[Math.min(ROUTES.length - 1, Math.max(0, index) + 1)]!;
}
