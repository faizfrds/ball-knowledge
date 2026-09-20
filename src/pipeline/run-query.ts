import type Database from "better-sqlite3";
import { AS_OF_DATE, DATASET_VERSION } from "../config.js";
import { assertAsOf } from "../data-access.js";
import { decideActions } from "../givecampus/actions.js";
import { EVIDENCE_VERSION } from "../givecampus/criterion.js";
import { checkEligibility } from "../givecampus/eligibility.js";
import {
  getAffiliations,
  getDegrees,
  getFutureEvents,
  getInteractionsAsOf,
  getPaidGiftsAsOf,
  listCandidateConstituents,
} from "../givecampus/store.js";
import { compilePipelineRubric, type PipelineCompileOutcome } from "../llm/pipeline-rubric.js";
import type { FetchFn } from "../llm/client.js";
import { buildConstituentCard, type ConstituentCard } from "../retrieval/item-card.js";
import { retrieveCandidates, type RetrievalOptions, type RetrievalResult } from "../retrieval/retrieve.js";
import {
  evaluateFinalTopTwentyActions,
  FINAL_ACTIONS,
  type FinalAction,
  type FinalActionDecision,
} from "./final-decision.js";
import {
  evaluateRubricForCandidates,
  type CandidateRubricEvaluation,
  type DynamicJevClient,
} from "./jev-evaluator.js";
import { SqliteQuestionAnswerCache, type QuestionAnswerCache } from "./question-cache.js";
import { rankByRubric, type RankedCandidate } from "./rank.js";
import { routeQuery, type RouteClassifier, type RouteDecision } from "./router.js";
import { DEFAULT_GIVECAMPUS_RUBRIC, FIELD_NAMES, type CompiledRubric } from "./rubric.js";

export interface QueryCostReceipt {
  datasetVersion: string;
  evidenceVersion: string;
  asOf: string;
  elapsedMs: number;
  scanned: number;
  eligible: number;
  filtered: number;
  retrieved: number;
  jevCalls: number;
  jevCacheHits: number;
  jevInputTokens: number;
  jevOutputTokens: number;
  finalDecisionCalls: number;
  llmCompileCalls: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  embedding: RetrievalResult["embedding"];
}

export interface QueryResult {
  route: RouteDecision;
  rubric: CompiledRubric;
  rubricFallback: boolean;
  retrieval: Omit<RetrievalResult, "candidates">;
  ranked: RankedCandidate[];
  topTwentyActions: FinalActionDecision[];
  receipt: QueryCostReceipt;
}

interface CandidatePolicy {
  card: ConstituentCard;
  eligibleForContact: boolean;
  eligibleForSolicitation: boolean;
  permittedActions: FinalAction[];
}

export interface RunQueryOptions extends RetrievalOptions {
  asOf?: string;
  candidateCap?: number;
  scanLimit?: number;
  routeClassifier?: RouteClassifier;
  llmFetchFn?: FetchFn;
  compile?: (query: string) => Promise<PipelineCompileOutcome>;
  jevClient?: DynamicJevClient;
  questionCache?: QuestionAnswerCache;
  questionCachePath?: string;
  jevConcurrency?: number;
  finalActionLimit?: number;
}

/**
 * Backend semantic-first query pipeline. Hybrid retrieval only selects the
 * pool; final ordering contains no retrieval, similarity, or embedding score.
 */
export async function runGiveCampusQuery(
  db: Database.Database,
  query: string,
  options: RunQueryOptions = {},
): Promise<QueryResult> {
  const startedAt = Date.now();
  const asOf = options.asOf ?? AS_OF_DATE;
  assertAsOf(asOf);
  if (!query.trim()) throw new Error("query is required");

  const route = await routeQuery(query, { classifier: options.routeClassifier });
  const compiled = route.route === "deep" || route.route === "analysis"
    ? await (options.compile?.(query) ?? compilePipelineRubric(query, FIELD_NAMES, { fetchFn: options.llmFetchFn }))
    : { rubric: structuredClone(DEFAULT_GIVECAMPUS_RUBRIC), fallback: true, reason: "route uses static rubric", telemetry: null };
  const rubric = { ...compiled.rubric, route: route.route };

  const source = buildEligibleCards(db, asOf, options.scanLimit ?? 20_000);
  const retrieval = await retrieveCandidates(source.policies.map((candidate) => candidate.card), rubric.phrasings, {
    candidateCap: options.candidateCap,
    rrfK: options.rrfK,
    filters: rubric.filters,
    embedder: options.embedder,
    embeddingCache: options.embeddingCache,
    batchSize: options.batchSize,
    datasetVersion: DATASET_VERSION,
    evidenceVersion: EVIDENCE_VERSION,
  });
  const policyById = new Map(source.policies.map((candidate) => [candidate.card.constituentId, candidate]));
  const ownedCache = options.questionCache ? null : new SqliteQuestionAnswerCache(options.questionCachePath);
  const cache = options.questionCache ?? ownedCache!;

  try {
    // The compiled next_action tag is deliberately removed here. Action is a
    // separate Choice pass over the final twenty only.
    const judgmentRubric = { ...rubric, tags: [] };
    const evaluations = await evaluateRubricForCandidates(
      retrieval.candidates.map((card) => ({
        constituentId: card.constituentId,
        fields: { ...card.fields },
        evidenceRefs: card.evidenceRefs,
        asOf,
      })),
      {
        rubric: judgmentRubric,
        asOf,
        datasetVersion: DATASET_VERSION,
        evidenceVersion: EVIDENCE_VERSION,
        client: options.jevClient,
        cache,
        concurrency: options.jevConcurrency,
      },
    );
    const ranked = rankByRubric(evaluations);
    const topTwentyActions = await evaluateFinalTopTwentyActions({
      rankedCandidates: ranked.map((candidate) => {
        const policy = policyById.get(candidate.constituentId)!;
        return {
          constituentId: candidate.constituentId,
          rank: candidate.rank,
          disposition: candidate.disposition,
          fields: { ...policy.card.fields },
          evidenceRefs: policy.card.evidenceRefs,
          eligibleForContact: policy.eligibleForContact,
          eligibleForSolicitation: policy.eligibleForSolicitation,
          permittedActions: policy.permittedActions,
        };
      }),
      fields: [
        "gift_recency_band", "gift_frequency_band", "giving_amount_band", "engagement_events",
        "interaction_summary", "career_change_band", "affiliation_type", "class_year", "city", "state",
        "contactability", "solicitation_fatigue_band",
      ],
      asOf,
      datasetVersion: DATASET_VERSION,
      evidenceVersion: EVIDENCE_VERSION,
      client: options.jevClient,
      cache,
      limit: options.finalActionLimit,
    });
    const telemetry = collectJevTelemetry(evaluations, topTwentyActions);
    return {
      route,
      rubric,
      rubricFallback: compiled.fallback,
      retrieval: withoutCandidates(retrieval),
      ranked,
      topTwentyActions,
      receipt: {
        datasetVersion: DATASET_VERSION,
        evidenceVersion: EVIDENCE_VERSION,
        asOf,
        elapsedMs: Date.now() - startedAt,
        scanned: source.scanned,
        eligible: source.policies.length,
        filtered: retrieval.filteredCount,
        retrieved: retrieval.candidateCount,
        ...telemetry,
        llmCompileCalls: compiled.telemetry ? 1 : 0,
        llmInputTokens: compiled.telemetry?.inputTokens ?? 0,
        llmOutputTokens: compiled.telemetry?.outputTokens ?? 0,
        embedding: retrieval.embedding,
      },
    };
  } finally {
    ownedCache?.close();
  }
}

function buildEligibleCards(db: Database.Database, asOf: string, scanLimit: number): { policies: CandidatePolicy[]; scanned: number } {
  if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > 20_000) throw new Error("scanLimit must be an integer in 1..20000");
  const rows = listCandidateConstituents(db, {
    asOf, limit: 20, offset: 0, excludeStudentSolicit: true, sort: "priority_desc",
  }, scanLimit);
  const futureEvents = getFutureEvents(db, asOf);
  const policies: CandidatePolicy[] = [];
  for (const row of rows) {
    const affiliations = getAffiliations(db, row.id);
    const degrees = getDegrees(db, row.id);
    const eligibility = checkEligibility({
      constituent: row,
      affiliations: affiliations.map((item) => ({ affiliation_type: item.affiliation_type })),
      degrees: degrees.map((item) => ({ class_year: item.class_year, degree_type: item.degree_type })),
      asOf,
    });
    if (!eligibility.eligibleForContact) continue;
    const gifts = getPaidGiftsAsOf(db, row.id, asOf);
    const interactions = getInteractionsAsOf(db, row.id, asOf);
    const action = decideActions({
      eligibility,
      gifts,
      interactions,
      futureEvents,
      asOf,
      constituentCity: row.city,
      constituentId: row.id,
    });
    const permitted = new Set<FinalAction>();
    if (action.permitted.includes("thank")) permitted.add("thank_you");
    if (action.permitted.includes("invite")) permitted.add("event_invite");
    if (action.permitted.includes("solicit")) permitted.add("ask");
    const classYear = degrees.map((degree) => degree.class_year).filter((year): year is number => year !== null).sort()[0];
    const alumni = affiliations.some((item) => /alumn/i.test(item.affiliation_type));
    if (alumni && classYear !== undefined && (Number(asOf.slice(0, 4)) - classYear) % 5 === 0) permitted.add("reunion_mailer");
    policies.push({
      card: buildConstituentCard({ db, constituentId: row.id, asOf }),
      eligibleForContact: eligibility.eligibleForContact,
      eligibleForSolicitation: eligibility.eligibleForSolicit,
      permittedActions: FINAL_ACTIONS.filter((candidate) => permitted.has(candidate)),
    });
  }
  return { policies, scanned: rows.length };
}

function withoutCandidates(result: RetrievalResult): Omit<RetrievalResult, "candidates"> {
  const { candidates: _candidates, ...receipt } = result;
  return receipt;
}

function collectJevTelemetry(evaluations: CandidateRubricEvaluation[], actions: FinalActionDecision[]) {
  const answers = evaluations.flatMap((evaluation) => [
    ...Object.values(evaluation.gates), ...Object.values(evaluation.scores),
    ...Object.values(evaluation.bonuses), ...Object.values(evaluation.tags),
  ]);
  return {
    jevCalls: answers.filter((answer) => !answer.cacheHit && answer.model !== null).length + actions.filter((answer) => !answer.cacheHit && answer.model !== null).length,
    jevCacheHits: answers.filter((answer) => answer.cacheHit).length + actions.filter((answer) => answer.cacheHit).length,
    jevInputTokens: answers.reduce((sum, answer) => sum + answer.inputTokens, 0) + actions.reduce((sum, answer) => sum + answer.inputTokens, 0),
    jevOutputTokens: answers.reduce((sum, answer) => sum + answer.outputTokens, 0) + actions.reduce((sum, answer) => sum + answer.outputTokens, 0),
    finalDecisionCalls: actions.filter((answer) => answer.model !== null && !answer.cacheHit).length,
  };
}
