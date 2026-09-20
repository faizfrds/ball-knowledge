/**
 * Full-corpus GiveCampus comparison: semantic retrieval vs semantic+BM25,
 * with Jev and OpenAI making the final action choice for the hybrid top 20.
 * Constituent IDs, row-level labels, model answers, and field values are never
 * written to the report. Live model inputs are as-of-safe item-card values.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATASET_VERSION, REPO_ROOT, resolveDbPath } from "../config.js";
import { loadServerEnv } from "../env.js";
import { checkEligibility, type ConstituentEligibilityRow } from "../givecampus/eligibility.js";
import { EVIDENCE_VERSION } from "../givecampus/criterion.js";
import { evaluateLlmRubricCandidate, MapLlmRubricCache } from "../benchmark/llm-rubric-adapter.js";
import { TypesafeDynamicJevClient } from "../pipeline/jev-evaluator.js";
import { buildFinalDecisionQuestion, evaluateFinalTopTwentyActions, type FinalAction } from "../pipeline/final-decision.js";
import { SqliteQuestionAnswerCache } from "../pipeline/question-cache.js";
import { rankBm25 } from "../retrieval/bm25.js";
import { EmbeddingCache, embeddingCacheKey } from "../retrieval/embedding-cache.js";
import { buildConstituentCard, type ConstituentCard } from "../retrieval/item-card.js";
import { reciprocalRankFusion } from "../retrieval/rrf.js";
import { byId, asOfRows, label, metrics, loadBundleMaps, loadLocalVectors, cosine,
  type GoldContract, type GoldQuery, type GradedLabel, type RecordBundle, type Metrics } from "./benchmark-complex-offline.js";

const AS_OF = "2025-08-31";
const GOLD_PATH = path.join(REPO_ROOT, "docs", "results", "complex-benchmark-gold-v1.json");
const JSON_PATH = path.join(REPO_ROOT, "docs", "results", "complex-benchmark-live.json");
const MD_PATH = path.join(REPO_ROOT, "docs", "results", "complex-benchmark-live.md");
const EMBEDDING_TELEMETRY_PATH = path.join(REPO_ROOT, "docs", "results", "complex-benchmark-embedding-telemetry.json");
const VECTOR_CACHE_PATH = path.join(REPO_ROOT, "data", "retrieval-cache.sqlite");
const JEV_CACHE_PATH = path.join(REPO_ROOT, "data", "complex-benchmark-jev-cache.sqlite");
const CANDIDATE_CAP = 2_000;
const ACTION_FIELDS = [
  "gift_recency_band", "gift_frequency_band", "giving_amount_band", "engagement_events",
  "interaction_summary", "career_change_band", "affiliation_type", "class_year", "city", "state",
  "contactability", "solicitation_fatigue_band",
] as const;
const ACTIONS: readonly FinalAction[] = ["thank_you", "event_invite", "reunion_mailer", "ask"];
const ACTION_QUESTIONS: Record<string, string> = {
  q1_lapsed_loyal_engaged: "Given this lapsed donor's recorded giving, engagement, career signal, and solicitation context, which one next action fits? Choose exactly one supplied action key; never abstain or invent another label.",
  q2_stewardship_before_ask: "Given the giving recency and acknowledgment context, which one next action should happen before any solicitation? Choose exactly one supplied action key; never abstain or invent another label.",
  q3_reunion_reengagement: "Given this alumnus's class-year, affinity, and giving context, which one next action best supports reunion reengagement? Choose exactly one supplied action key; never abstain or invent another label.",
  q4_upgrade_ask_review: "Given the recorded giving, engagement, and career context, which one next action is appropriate? Treat title and employer as context only, not proof of capacity. Choose exactly one supplied action key; never abstain or invent another label.",
};
const ACTION_OPTIONS: Record<string, Record<FinalAction, string>> = {
  q1_lapsed_loyal_engaged: {
    thank_you: "Choose only when giving recency and interaction context indicate a recent gift still needing stewardship.",
    event_invite: "Choose for a broad cultivation invitation when the record shows affinity but not a personal-ask signal.",
    reunion_mailer: "Choose only when affiliation and class year support a relevant reunion invitation.",
    ask: "Choose for personal outreach to a previously loyal, lapsed donor with current engagement or career momentum, if solicitation is permitted.",
  },
  q2_stewardship_before_ask: {
    thank_you: "Prioritize stewardship when recent giving is present and interaction history does not show an acknowledgment after it.",
    event_invite: "Choose only when a recent unacknowledged gift is not the immediate next step and engagement supports an invitation.",
    reunion_mailer: "Choose only when reunion context is a clearer immediate next step than gift stewardship.",
    ask: "Do not choose a direct ask before a recent gift has been appropriately acknowledged.",
  },
  q3_reunion_reengagement: {
    thank_you: "Choose only for a recent unacknowledged gift; old giving alone is not a thank-you signal.",
    event_invite: "Choose for an affinity-based invitation when reunion-year evidence is incomplete.",
    reunion_mailer: "Prefer for a lapsed alumnus whose class-year and affiliation indicate an approaching reunion and whose record shows affinity.",
    ask: "This query is for reunion reengagement; do not make a direct ask.",
  },
  q4_upgrade_ask_review: {
    thank_you: "Choose only for a recent unacknowledged gift that should be stewarded before another ask.",
    event_invite: "Choose when giving is consistent but evidence for a direct ask is incomplete or suggests a stretch.",
    reunion_mailer: "Choose only when reunion context is more relevant than the requested upgrade conversation.",
    ask: "Choose when consistent giving, increasing engagement, and current career context support a personal conversation; title and employer are not proof of wealth.",
  },
};

function sha(text: string): string { return crypto.createHash("sha256").update(text, "utf8").digest("hex"); }
function hashIdentity(value: string): string { return sha(value); }
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
function ratio(n: number, d: number): number { return d === 0 ? 0 : Number((n / d).toFixed(6)); }

function actionGold(queryId: string, gold: GradedLabel, canSolicit: boolean): FinalAction | null {
  if (gold.grade === 0 || gold.action === "hold_for_review" || gold.action === "exclude") return null;
  if (queryId === "q1_lapsed_loyal_engaged") {
    return gold.action === "personal_outreach" && canSolicit ? "ask" : "event_invite";
  }
  if (queryId === "q2_stewardship_before_ask") return gold.action === "thank_you" ? "thank_you" : null;
  if (queryId === "q3_reunion_reengagement") return gold.action === "reunion_mailer" ? "reunion_mailer" : "event_invite";
  if (queryId === "q4_upgrade_ask_review") return gold.action === "ask" && canSolicit ? "ask" : "event_invite";
  return null;
}

function actionMetrics(
  decisions: { constituentId: number; action: FinalAction | null; overridden: boolean }[],
  goldById: Map<number, FinalAction | null>,
) {
  let scored = 0, correct = 0;
  for (const decision of decisions) {
    const expected = goldById.get(decision.constituentId) ?? null;
    if (expected === null) continue;
    scored++;
    if (decision.action === expected) correct++;
  }
  const counts: Record<string, number> = Object.fromEntries(ACTIONS.map((action) => [action, 0]));
  for (const decision of decisions) if (decision.action) counts[decision.action]++;
  return {
    topTwentyN: decisions.length,
    goldActionScoredN: scored,
    exactActionAccuracy: ratio(correct, scored),
    correctN: correct,
    modelActionCounts: counts,
    permissionOverrides: decisions.filter((decision) => decision.overridden).length,
  };
}

function summarizeJev(decisions: Awaited<ReturnType<typeof evaluateFinalTopTwentyActions>>) {
  const live = decisions.filter((row) => !row.cacheHit && row.model !== null);
  const counts: Record<string, number> = {};
  const actions: Record<string, number> = Object.fromEntries(ACTIONS.map((action) => [action, 0]));
  for (const row of decisions) {
    if (row.model) counts[row.model] = (counts[row.model] ?? 0) + 1;
    if (row.action) actions[row.action]++;
  }
  return {
    requestedModel: "jev-1.13.0",
    evaluatedN: decisions.length,
    liveCalls: live.length,
    cacheHits: decisions.filter((row) => row.cacheHit).length,
    errorsOrUnknown: decisions.filter((row) => row.status === "unknown").length,
    resolvedModelCounts: counts,
    inputTokens: decisions.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: decisions.reduce((sum, row) => sum + row.outputTokens, 0),
    latencyMs: { p50: percentile(live.map((row) => row.latencyMs), 0.5), p95: percentile(live.map((row) => row.latencyMs), 0.95) },
    finalActions: actions,
  };
}

function summaryLlm(results: Awaited<ReturnType<typeof evaluateLlmRubricCandidate>>[]) {
  const live = results.filter((row) => !row.telemetry.cacheHit);
  const counts: Record<string, number> = {};
  const actions: Record<string, number> = Object.fromEntries(ACTIONS.map((action) => [action, 0]));
  for (const row of results) {
    counts[row.telemetry.model] = (counts[row.telemetry.model] ?? 0) + 1;
    if (row.action) actions[row.action]++;
  }
  return {
    requestedModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    evaluatedN: results.length,
    liveCalls: live.length,
    cacheHits: results.length - live.length,
    unknownActions: results.filter((row) => row.action === null).length,
    resolvedModelCounts: counts,
    inputTokens: results.reduce((sum, row) => sum + row.telemetry.inputTokens, 0),
    outputTokens: results.reduce((sum, row) => sum + row.telemetry.outputTokens, 0),
    latencyMs: { p50: percentile(live.map((row) => row.telemetry.latencyMs), 0.5), p95: percentile(live.map((row) => row.telemetry.latencyMs), 0.95) },
    finalActions: actions,
  };
}

async function parallelMap<T, U>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  loadServerEnv();
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is not configured");
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("TYPESAFE_API_KEY is not configured");
  const frozen = JSON.parse(fs.readFileSync(GOLD_PATH, "utf8")) as GoldContract;
  if (frozen.asOf !== AS_OF || frozen.protocol !== "givecampus-complex-offline-v1" || frozen.queries.length !== 4) {
    throw new Error("Frozen four-query gold contract is missing or incompatible");
  }
  const db = new Database(resolveDbPath(), { readonly: true, fileMustExist: true });
  const vectorCache = new EmbeddingCache(VECTOR_CACHE_PATH);
  const jevCache = new SqliteQuestionAnswerCache(JEV_CACHE_PATH);
  const llmCache = new MapLlmRubricCache();
  const started = Date.now();
  try {
    const constituents = db.prepare(`SELECT id, entity_type, deceased, deceased_date, do_not_solicit,
      email_status, phone_status FROM constituents ORDER BY id`).all() as ConstituentEligibilityRow[];
    const affiliations = byId(db.prepare(`SELECT constituent_id, affiliation_type FROM affiliations`).all() as
      { constituent_id: number; affiliation_type: string }[]);
    const degrees = byId(db.prepare(`SELECT constituent_id, class_year, degree_type FROM degrees`).all() as
      { constituent_id: number; class_year: number | null; degree_type: string | null }[]);
    const contactAllowed = new Map<number, boolean>();
    const solicitAllowed = new Map<number, boolean>();
    const eligibleIds: number[] = [];
    for (const constituent of constituents) {
      const eligibility = checkEligibility({
        constituent,
        affiliations: asOfRows(affiliations, constituent.id),
        degrees: asOfRows(degrees, constituent.id),
        asOf: AS_OF,
      });
      contactAllowed.set(constituent.id, eligibility.eligibleForContact);
      solicitAllowed.set(constituent.id, eligibility.eligibleForSolicit);
      if (eligibility.eligibleForContact) eligibleIds.push(constituent.id);
    }
    const cards = eligibleIds.map((constituentId) => buildConstituentCard({ db, constituentId, asOf: AS_OF }));
    const cardById = new Map(cards.map((card) => [card.constituentId, card]));
    const data = loadBundleMaps(db);
    const bundles = new Map<number, RecordBundle>();
    for (const id of eligibleIds) bundles.set(id, {
      gifts: asOfRows(data.gifts, id), interactions: asOfRows(data.interactions, id),
      attendance: asOfRows(data.attendance, id), career: asOfRows(data.career, id),
      degrees: asOfRows(data.degrees, id), activities: asOfRows(data.activities, id),
    });
    const vectors = loadLocalVectors(cards, frozen.queries);
    if (!vectors.status.available) throw new Error(`Exact full-corpus vectors unavailable: ${vectors.status.reason}`);
    const embeddingTelemetry = JSON.parse(fs.readFileSync(EMBEDDING_TELEMETRY_PATH, "utf8")) as Record<string, unknown>;
    console.log(JSON.stringify({ phase: "live_decisions_started", eligibleN: cards.length,
      candidateCap: CANDIDATE_CAP, queries: frozen.queries.length, embeddingCache: vectors.status.cachePath }));

    const results: Record<string, unknown>[] = [];
    const jevClient = new TypesafeDynamicJevClient();
    const actionRubrics = new Map(frozen.queries.map((query) => [query.id,
      buildFinalDecisionQuestion([...ACTION_FIELDS], ACTION_QUESTIONS[query.id]!, ACTION_OPTIONS[query.id]!)]));

    for (const query of frozen.queries) {
      const grades = new Map<number, number>();
      const goldLabels = new Map<number, GradedLabel>();
      const goldActions = new Map<number, FinalAction | null>();
      const gradeActions: Record<string, number> = {};
      for (const id of eligibleIds) {
        const row = label(query.id, bundles.get(id)!, solicitAllowed.get(id) ?? false);
        grades.set(id, row.grade);
        goldLabels.set(id, row);
        goldActions.set(id, actionGold(query.id, row, solicitAllowed.get(id) ?? false));
        gradeActions[row.action] = (gradeActions[row.action] ?? 0) + 1;
      }
      const queryVector = vectors.vectors.get(`query:${hashIdentity(query.query)}`);
      if (!queryVector) throw new Error(`Query vector missing for frozen query ${query.id}`);
      const semanticStart = Date.now();
      const semanticRanked = cards.map((card) => ({
        id: card.constituentId,
        score: cosine(queryVector, vectors.vectors.get(`card:${card.hash}`) ?? []),
      })).sort((a, b) => b.score - a.score || a.id - b.id).map((row) => row.id);
      const semanticMs = Date.now() - semanticStart;
      const bm25Start = Date.now();
      const bm25 = rankBm25(query.query, cards.map((card) => ({ id: card.constituentId, text: card.searchText })))
        .map((row) => Number(row.id));
      const bm25Seen = new Set(bm25);
      const bm25Full = [...bm25, ...eligibleIds.filter((id) => !bm25Seen.has(id))];
      const bm25Ms = Date.now() - bm25Start;
      const fusionStart = Date.now();
      const hybridRetrieved = reciprocalRankFusion([semanticRanked, bm25], 60).map((row) => Number(row.id));
      const hybridSeen = new Set(hybridRetrieved);
      const hybridRanked = [...hybridRetrieved, ...eligibleIds.filter((id) => !hybridSeen.has(id))];
      const hybridMs = Date.now() - fusionStart;
      const hybridTop = hybridRanked.slice(0, 20);

      const jevCandidates = hybridTop.map((id, index) => ({
        constituentId: id, rank: index + 1, disposition: "eligible" as const,
        fields: { ...(cardById.get(id)!.fields) }, evidenceRefs: cardById.get(id)!.evidenceRefs,
        eligibleForContact: contactAllowed.get(id) ?? false,
        eligibleForSolicitation: solicitAllowed.get(id) ?? false,
        permittedActions: ACTIONS.filter((action) => action !== "ask" || (solicitAllowed.get(id) ?? false)),
      }));
      const jevActions = await evaluateFinalTopTwentyActions({
        rankedCandidates: jevCandidates,
        fields: [...ACTION_FIELDS],
        asOf: AS_OF,
        datasetVersion: DATASET_VERSION,
        evidenceVersion: EVIDENCE_VERSION,
        client: jevClient,
        cache: jevCache,
        limit: 20,
        question: ACTION_QUESTIONS[query.id],
        actionOptions: ACTION_OPTIONS[query.id],
      });
      const jevActionQuality = actionMetrics(jevActions.map((row) => ({
        constituentId: row.constituentId, action: row.action, overridden: row.overridden,
      })), goldActions);

      const llmRubric = actionRubrics.get(query.id)!.rubric;
      const llmRaw = await parallelMap(hybridTop, 8, async (id) => evaluateLlmRubricCandidate({
        candidate: { candidateId: id, fields: { ...(cardById.get(id)!.fields) } },
        rubric: llmRubric,
        asOf: AS_OF,
        options: { cache: llmCache, datasetVersion: DATASET_VERSION, evidenceVersion: EVIDENCE_VERSION,
          actionCriterionId: "final_action" },
      }));
      const llmActions = llmRaw.map((row, index) => {
        const id = hybridTop[index]!;
        const requested = row.action;
        const allowed = requested !== null && (requested !== "ask" || (solicitAllowed.get(id) ?? false));
        const fallback = ACTIONS.find((action) => action !== "ask" || (solicitAllowed.get(id) ?? false)) ?? null;
        return { constituentId: id, action: allowed ? requested : fallback,
          overridden: requested !== null && !allowed };
      });
      const llmActionQuality = actionMetrics(llmActions, goldActions);

      results.push({
        id: query.id,
        gradeCounts: [0, 1, 2, 3].map((grade) => [...grades.values()].filter((value) => value === grade).length),
        goldActionCounts: Object.fromEntries(Object.entries(gradeActions).sort()),
        rankings: {
          semanticOnly: { metrics: metrics(semanticRanked, grades), latencyMs: semanticMs },
          semanticPlusBm25: { metrics: metrics(hybridRanked, grades), latencyMs: bm25Ms + hybridMs,
            retrievedCandidateCount: Math.min(CANDIDATE_CAP, eligibleIds.length) },
        },
        finalTopTwentyActions: {
          jev: { quality: jevActionQuality, telemetry: summarizeJev(jevActions) },
          llm: { quality: llmActionQuality, telemetry: summaryLlm(llmRaw) },
        },
        semanticRetrievalLatencyMs: semanticMs,
      });
      console.log(JSON.stringify({ phase: "query_complete", query: query.id,
        semanticHitsAt20: (results.at(-1) as { rankings: { semanticOnly: { metrics: Metrics } } }).rankings.semanticOnly.metrics.hitsAt20,
        hybridHitsAt20: (results.at(-1) as { rankings: { semanticPlusBm25: { metrics: Metrics } } }).rankings.semanticPlusBm25.metrics.hitsAt20,
        jevCalls: jevActions.length, llmCalls: llmRaw.length }));
    }

    const vectorCacheSize = vectorCache.size;
    const report = {
      protocol: "givecampus-complex-live-v1",
      goldProtocol: frozen.protocol,
      goldSpecSha256: sha(fs.readFileSync(GOLD_PATH, "utf8")),
      asOf: AS_OF,
      datasetVersion: DATASET_VERSION,
      evidenceVersion: EVIDENCE_VERSION,
      population: { eligibility: "checkEligibility eligibleForContact as of cutoff", eligibleN: eligibleIds.length,
        totalConstituentRows: constituents.length },
      retrieval: { semantic: "full-population cosine ranking over cached text-embedding-3-small vectors",
      hybrid: "full-population BM25 and embedding rank lists fused with RRF k=60; top-2,000 candidate pool",
        candidatePoolSize: Math.min(CANDIDATE_CAP, eligibleIds.length), vectorCacheSize,
        embedding: { ...vectors.status, usage: embeddingTelemetry } },
      finalDecision: { jev: "Jev receives only allowlisted as-of-safe raw field values for the hybrid top 20 per query; never embeddings or retrieval scores",
        llm: "OpenAI receives the same top-20 raw field values and a separate final action choice; ask is overridden when solicitation is disallowed",
        actions: ACTIONS, evaluation: "exact action agreement only where the frozen gold label maps to one of the four supported actions; unsupported hold/exclude labels are unscored" },
      metrics: { gradedNdcgGain: "2^relevance-1", relevant: "grade > 0", ties: "constituent ID ascending", cutoffs: [100, 500, 2_000] },
      queries: results,
      totalRuntimeMs: Date.now() - started,
      outputsContainConstituentIds: false,
      rowLevelModelAnswersPersisted: false,
      futureOutcomeLabelsLoaded: false,
      limitations: ["Q3 grade-2 branch in the frozen gold implementation is unreachable; see frozen spec and source label rules."],
    };
    fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
    fs.writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const lines = [
      "# Full-Corpus Live Fundraising Benchmark", "",
      `Frozen query set: [complex-benchmark-gold-v1.json](complex-benchmark-gold-v1.json). Cutoff ${AS_OF}; eligible population ${eligibleIds.length.toLocaleString()}.`,
      "Semantic-only and semantic+BM25 rankings cover the full population. Jev and OpenAI each make a final action choice for the exact same hybrid top 20 per query; only as-of-safe raw field values are sent, never embeddings or retrieval scores.",
      "",
      "| Query | Ranker | Relevant / N | Recall@100 | Recall@500 | Recall@2k | NDCG@10 | NDCG@20 | P@20 | Hits@20 | Retrieval ms |",
      "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ];
    for (const result of results as { id: string; rankings: { semanticOnly: { metrics: Metrics; latencyMs: number }; semanticPlusBm25: { metrics: Metrics; latencyMs: number } } }[]) {
      for (const [name, value] of Object.entries(result.rankings)) {
        const m = value.metrics;
        lines.push(`| ${result.id} | ${name} | ${m.relevantN} / ${eligibleIds.length} | ${m.recallAt100.toFixed(4)} | ${m.recallAt500.toFixed(4)} | ${m.recallAt2000.toFixed(4)} | ${m.ndcgAt10.toFixed(4)} | ${m.ndcgAt20.toFixed(4)} | ${m.precisionAt20.toFixed(4)} | ${m.hitsAt20} | ${value.latencyMs} |`);
      }
    }
    lines.push("", "## Final top-20 action decisions", "", "| Query | Decision model | Scored gold actions | Exact action accuracy | Correct | Permission overrides | Calls | Input tokens | Output tokens |", "|---|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const result of results as { id: string; finalTopTwentyActions: { jev: { quality: ReturnType<typeof actionMetrics>; telemetry: ReturnType<typeof summarizeJev> }; llm: { quality: ReturnType<typeof actionMetrics>; telemetry: ReturnType<typeof summaryLlm> } } }[]) {
      for (const [name, value] of Object.entries(result.finalTopTwentyActions)) {
        lines.push(`| ${result.id} | ${name} | ${value.quality.goldActionScoredN} / 20 | ${value.quality.exactActionAccuracy.toFixed(4)} | ${value.quality.correctN} | ${value.quality.permissionOverrides} | ${value.telemetry.liveCalls} | ${value.telemetry.inputTokens} | ${value.telemetry.outputTokens} |`);
      }
    }
    lines.push("", `Embedding: ${vectors.status.model}; full vector cache contains ${vectorCacheSize.toLocaleString()} embeddings; ${String(embeddingTelemetry.totalInputTokens)} total input tokens, estimated $${Number(embeddingTelemetry.estimatedTotalCostUsd).toFixed(6)}.`,
      "Gold metrics are full-population graded retrieval metrics. Exact action accuracy excludes grade-0/exclude and hold-for-review cases because those are not among the four allowed actions.",
      "Q3 grade-2 gold branch is unreachable in the frozen reference implementation; interpret Q3 grade counts accordingly.",
      `Total live runner time: ${report.totalRuntimeMs} ms.`, "");
    fs.writeFileSync(MD_PATH, lines.join("\n"), "utf8");
    console.log(lines.join("\n"));
    console.log(`\nWrote ${path.relative(REPO_ROOT, JSON_PATH)} and ${path.relative(REPO_ROOT, MD_PATH)}.`);
  } finally {
    jevCache.close();
    vectorCache.close();
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Live complex benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
