/**
 * Offline complex retrieval benchmark. Reads only the local SQLite dataset and
 * compatible local embedding-cache entries; it never invokes a network client.
 * The frozen gold contract lives at docs/results/complex-benchmark-gold-v1.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DATASET_VERSION, REPO_ROOT, resolveDbPath } from "../../config.js";
import { checkEligibility, type ConstituentEligibilityRow } from "../../givecampus/eligibility.js";
import { EVIDENCE_VERSION } from "../../givecampus/criterion.js";
import { buildConstituentCard, type ConstituentCard } from "../../retrieval/item-card.js";
import { rankBm25 } from "../../retrieval/bm25.js";
import { embeddingCacheKey } from "../../retrieval/embedding-cache.js";
import { reciprocalRankFusion } from "../../retrieval/rrf.js";

const AS_OF = "2025-08-31";
const TOP_K = [100, 500, 2000] as const;
const CACHE_MODEL = "text-embedding-3-small";
const GOLD_PATH = path.join(REPO_ROOT, "docs", "results", "complex-benchmark-gold-v1.json");
const JSON_PATH = path.join(REPO_ROOT, "docs", "results", "complex-benchmark-precompute.json");
const MD_PATH = path.join(REPO_ROOT, "docs", "results", "complex-benchmark-precompute.md");
const PRECOMPUTE_PATH = path.join(REPO_ROOT, "data", "characteristics-full", "characteristics-2026-08-31.json");

// Signal weights per frozen query over Jev-precomputed yes/no verdicts.
const PRE_WEIGHTS: Record<string, Record<string, number>> = {
  q1_lapsed_loyal_engaged: {
    lapsed_over_730d: 2, lifetime_at_least_1000: 1.5, any_engagement_events: 1.5,
    connected_within_365d: 1, gifts_24mo_at_least_5: 0.5, gave_within_90d: -1.5,
  },
  q2_stewardship_before_ask: {
    gave_within_90d: 3, lifetime_at_least_1000: 1, connected_within_365d: 1, lapsed_over_730d: -2,
  },
  q3_reunion_reengagement: {
    lapsed_over_730d: 2, any_engagement_events: 2, connected_within_365d: 1, gave_within_90d: -1,
  },
  q4_upgrade_ask_review: {
    gifts_24mo_at_least_5: 2, lifetime_at_least_1000: 2, any_engagement_events: 1, gave_within_90d: 1,
  },
};

export interface GoldQuery { id: string; query: string }
export interface GoldContract { protocol: string; asOf: string; queries: GoldQuery[] }
interface Gift { gift_date: string; amount: number; status: string; gift_type: string }
interface Interaction { occurred_at: string; purpose: string; outcome: string; follow_up_date: string | null }
interface Attendance { attended_at: string }
interface Career { recorded_at: string; is_current: number }
interface Degree { class_year: number | null; degree_type: string | null }
interface Activity { activity_type: string | null; activity_name: string | null }
export interface RecordBundle {
  gifts: Gift[]; interactions: Interaction[]; attendance: Attendance[];
  career: Career[]; degrees: Degree[]; activities: Activity[];
}
export interface GradedLabel { grade: 0 | 1 | 2 | 3; action: string }
export interface Metrics {
  recallAt100: number; recallAt500: number; recallAt2000: number;
  ndcgAt10: number; ndcgAt20: number; precisionAt20: number; recallAt20: number;
  mrr: number; hitsAt20: number; relevantN: number;
}

const CONNECTED = new Set(["connected", "replied", "meeting_booked", "gift_received", "pledged"]);
const UNDERGRAD = new Set(["B.A.", "A.B.", "B.S.", "B.B.A."]);

function dayOffset(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}
export function byId<T extends { constituent_id: number }>(rows: T[]): Map<number, T[]> {
  const result = new Map<number, T[]>();
  for (const row of rows) {
    const list = result.get(row.constituent_id);
    if (list) list.push(row); else result.set(row.constituent_id, [row]);
  }
  return result;
}
export function asOfRows<T extends { constituent_id: number }>(map: Map<number, T[]>, id: number): T[] {
  return map.get(id) ?? [];
}
function paid(gift: Gift): boolean { return gift.status === "paid" && gift.gift_type !== "recurring_parent"; }
function betweenRecent(day: string, asOf: string, days: number): boolean {
  return day.slice(0, 10) > dayOffset(asOf, -days) && day.slice(0, 10) <= asOf;
}
function solicitation(row: Interaction): boolean { return /solicit|ask|fundrais/i.test(row.purpose); }
function acknowledged(row: Interaction): boolean { return /thank|acknowledg|steward/i.test(row.purpose); }

export function label(queryId: string, row: RecordBundle, canSolicit: boolean): GradedLabel {
  const gifts = row.gifts.filter(paid);
  const interactions = row.interactions;
  const latestPaid = gifts.at(-1)?.gift_date.slice(0, 10) ?? null;
  const recentSolicitation = interactions.some((i) => solicitation(i) && betweenRecent(i.occurred_at, AS_OF, 30));
  const careerRecent180 = row.career.some((c) => betweenRecent(c.recorded_at, AS_OF, 180));
  const event730 = row.attendance.filter((a) => betweenRecent(a.attended_at, AS_OF, 730)).length;
  const activeActivities = row.activities.length;
  const connected730 = interactions.filter((i) => CONNECTED.has(i.outcome) && betweenRecent(i.occurred_at, AS_OF, 730)).length;
  const engagement730 = event730 + activeActivities + connected730;
  const lapsed1095 = latestPaid === null || latestPaid <= dayOffset(AS_OF, -1095);

  if (queryId === "q1_lapsed_loyal_engaged") {
    const loyal = gifts.length >= 3;
    const engaged = engagement730 > 0;
    const strong = engagement730 >= 3;
    const careerSignal = careerRecent180 || (row.career.length === 0 && strong);
    const recentSolicit = recentSolicitation;
    const collision = row.gifts.some((g) => (g.status === "pledged" || g.status === "pending") && g.gift_date.slice(0, 10) <= AS_OF) ||
      interactions.some((i) => i.outcome === "meeting_booked" && i.follow_up_date !== null && i.follow_up_date.slice(0, 10) >= AS_OF);
    if (recentSolicit || !lapsed1095 || !engaged) return { grade: 0, action: "exclude" };
    if (collision) return { grade: 0, action: "hold_for_review" };
    if (loyal && careerSignal) return { grade: 3, action: "personal_outreach" };
    if (loyal) return { grade: 2, action: "broad_invite" };
    return { grade: (Number(loyal) + Number(lapsed1095) + Number(engaged) >= 2 ? 1 : 0) as 0 | 1, action: "broad_invite" };
  }

  if (queryId === "q2_stewardship_before_ask") {
    const recent = gifts.filter((g) => paid(g) && betweenRecent(g.gift_date, AS_OF, 90));
    const meaningful = recent.filter((g) => Number(g.amount) >= 250);
    const moderate = recent.filter((g) => Number(g.amount) >= 100);
    const latestQualifying = meaningful.at(-1) ?? moderate.at(-1) ?? recent.at(-1);
    if (!latestQualifying) return { grade: 0, action: "exclude" };
    const giftDay = latestQualifying.gift_date.slice(0, 10);
    if (interactions.some((i) => acknowledged(i) && i.occurred_at.slice(0, 10) > giftDay && i.occurred_at.slice(0, 10) <= AS_OF)) {
      return { grade: 0, action: "exclude" };
    }
    if (meaningful.length > 0) return { grade: 3, action: "thank_you" };
    if (moderate.length > 0) return { grade: 2, action: "thank_you" };
    return { grade: 1, action: "hold_for_review" };
  }

  if (queryId === "q3_reunion_reengagement") {
    const classYears = row.degrees.filter((d) => d.class_year !== null && UNDERGRAD.has(d.degree_type ?? ""))
      .map((d) => d.class_year as number);
    const classYear = classYears.length ? Math.min(...classYears) : null;
    const alumni = classYear !== null && classYear <= 2025;
    const age = alumni ? 2025 - classYear! : null;
    const reunion = age !== null && [0, 1].includes(age % 5);
    const lapsed = lapsed1095;
    const affinity = row.attendance.some((a) => betweenRecent(a.attended_at, AS_OF, 1825)) ||
      row.activities.length > 0 || interactions.some((i) => CONNECTED.has(i.outcome) && betweenRecent(i.occurred_at, AS_OF, 1825));
    if (recentSolicitation) return { grade: 0, action: "exclude" };
    if (alumni && reunion && lapsed && affinity) return { grade: 3, action: "reunion_mailer" };
    const count = Number(alumni && reunion) + Number(lapsed) + Number(affinity);
    if (count === 3) return { grade: 2, action: "event_invite" };
    if (count === 2) return { grade: 1, action: "event_invite" };
    return { grade: 0, action: "exclude" };
  }

  if (queryId === "q4_upgrade_ask_review") {
    const consistent = gifts.length >= 3 && gifts.some((g) => betweenRecent(g.gift_date, AS_OF, 1825));
    const recentEngagement = row.attendance.filter((a) => betweenRecent(a.attended_at, AS_OF, 730)).length +
      interactions.filter((i) => CONNECTED.has(i.outcome) && betweenRecent(i.occurred_at, AS_OF, 730)).length;
    const previousEngagement = row.attendance.filter((a) => {
      const day = a.attended_at.slice(0, 10);
      return day > dayOffset(AS_OF, -1460) && day <= dayOffset(AS_OF, -730);
    }).length + interactions.filter((i) => {
      const day = i.occurred_at.slice(0, 10);
      return CONNECTED.has(i.outcome) && day > dayOffset(AS_OF, -1460) && day <= dayOffset(AS_OF, -730);
    }).length;
    const increasing = recentEngagement > previousEngagement;
    const careerEvidence = row.career.some((c) => c.is_current === 1);
    const largest = gifts.reduce((max, g) => Math.max(max, Number(g.amount)), 0);
    if (consistent && increasing && careerEvidence && largest >= 250) return { grade: 3, action: canSolicit ? "ask" : "event_invite" };
    if (consistent && increasing) return { grade: 2, action: "hold_for_review" };
    if (consistent) return { grade: 1, action: "event_invite" };
    return { grade: 0, action: "exclude" };
  }
  throw new Error(`Unknown frozen query: ${queryId}`);
}

function dcg(grades: number[]): number {
  return grades.reduce((total, grade, i) => total + ((2 ** grade - 1) / Math.log2(i + 2)), 0);
}
function ratio(n: number, d: number): number { return d === 0 ? 0 : Number((n / d).toFixed(6)); }
export function metrics(rankedIds: number[], grades: Map<number, number>): Metrics {
  const relevantN = [...grades.values()].filter((grade) => grade > 0).length;
  const recallAt = (k: number) => ratio(rankedIds.slice(0, k).filter((id) => (grades.get(id) ?? 0) > 0).length, relevantN);
  const ndcg = (k: number) => {
    const ideal = [...grades.values()].sort((a, b) => b - a).slice(0, k);
    return ratio(dcg(rankedIds.slice(0, k).map((id) => grades.get(id) ?? 0)), dcg(ideal));
  };
  let firstRelevant = 0;
  for (let i = 0; i < rankedIds.length; i++) {
    if ((grades.get(rankedIds[i]!) ?? 0) > 0) { firstRelevant = i + 1; break; }
  }
  const hitsAt20 = rankedIds.slice(0, 20).filter((id) => (grades.get(id) ?? 0) > 0).length;
  return {
    recallAt100: recallAt(100), recallAt500: recallAt(500), recallAt2000: recallAt(2000),
    ndcgAt10: ndcg(10), ndcgAt20: ndcg(20), precisionAt20: ratio(hitsAt20, Math.min(20, rankedIds.length)),
    recallAt20: recallAt(20), mrr: firstRelevant === 0 ? 0 : Number((1 / firstRelevant).toFixed(6)),
    hitsAt20, relevantN,
  };
}
function hashText(text: string): string { return crypto.createHash("sha256").update(text, "utf8").digest("hex"); }
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! * a[i]!; bb += b[i]! * b[i]!; }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}
export function loadLocalVectors(cards: ConstituentCard[], queries: GoldQuery[]): {
  status: { available: boolean; cachePath: string | null; model: string; missingCardVectors: number; missingQueryVectors: number; reason: string | null };
  vectors: Map<string, number[]>;
} {
  const candidates = ["data/retrieval-cache.sqlite", "data/semantic-emb-cache.sqlite"]
    .map((p) => path.join(REPO_ROOT, p)).filter((p) => fs.existsSync(p));
  const miss = (reason: string) => ({
    status: { available: false, cachePath: null, model: CACHE_MODEL, missingCardVectors: cards.length,
      missingQueryVectors: queries.length, reason }, vectors: new Map<string, number[]>(),
  });
  for (const cachePath of candidates) {
    let cache: Database.Database | null = null;
    try {
      cache = new Database(cachePath, { readonly: true, fileMustExist: true });
      const table = cache.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_cache'").get();
      if (!table) continue;
      const get = cache.prepare("SELECT model, dimensions, vector FROM embedding_cache WHERE cache_key = ?");
      const vectors = new Map<string, number[]>();
      let missingCardVectors = 0;
      for (const card of cards) {
        const identity = `card:${card.hash}`;
        const key = embeddingCacheKey({ asOf: AS_OF, itemCardHash: identity, model: CACHE_MODEL });
        const row = get.get(key) as { model: string; dimensions: number; vector: Buffer } | undefined;
        if (!row || row.model !== CACHE_MODEL || row.vector.byteLength !== row.dimensions * 4) { missingCardVectors++; continue; }
        vectors.set(identity, Array.from({ length: row.dimensions }, (_, i) => row.vector.readFloatLE(i * 4)));
      }
      let missingQueryVectors = 0;
      for (const query of queries) {
        const identity = `query:${hashText(query.query)}`;
        const key = embeddingCacheKey({ asOf: AS_OF, itemCardHash: identity, model: CACHE_MODEL });
        const row = get.get(key) as { model: string; dimensions: number; vector: Buffer } | undefined;
        if (!row || row.model !== CACHE_MODEL || row.vector.byteLength !== row.dimensions * 4) { missingQueryVectors++; continue; }
        vectors.set(identity, Array.from({ length: row.dimensions }, (_, i) => row.vector.readFloatLE(i * 4)));
      }
      if (missingCardVectors === 0 && missingQueryVectors === 0) {
        return { status: { available: true, cachePath: path.relative(REPO_ROOT, cachePath), model: CACHE_MODEL,
          missingCardVectors, missingQueryVectors, reason: null }, vectors };
      }
      const result = { status: { available: false, cachePath: path.relative(REPO_ROOT, cachePath), model: CACHE_MODEL,
        missingCardVectors, missingQueryVectors, reason: "cache does not contain the complete exact card and query set; live embedding calls are disabled" }, vectors };
      cache.close(); cache = null;
      return result;
    } catch {
      // An old, incompatible cache is ignored without dumping its contents.
    } finally { cache?.close(); }
  }
  return miss(candidates.length ? "no compatible embedding_cache table found; live embedding calls are disabled" : "no local embedding cache found; live embedding calls are disabled");
}

export function loadBundleMaps(db: Database.Database) {
  const gifts = byId(db.prepare(`SELECT constituent_id, gift_date, amount, status, gift_type FROM gifts
    WHERE substr(gift_date,1,10) <= ? ORDER BY gift_date`).all(AS_OF) as (Gift & { constituent_id: number })[]);
  const interactions = byId(db.prepare(`SELECT constituent_id, occurred_at, purpose, outcome, follow_up_date FROM interactions
    WHERE substr(occurred_at,1,10) <= ? ORDER BY occurred_at`).all(AS_OF) as (Interaction & { constituent_id: number })[]);
  const attendance = byId(db.prepare(`SELECT constituent_id, attended_at FROM event_attendance
    WHERE substr(attended_at,1,10) <= ? ORDER BY attended_at`).all(AS_OF) as (Attendance & { constituent_id: number })[]);
  const career = byId(db.prepare(`SELECT constituent_id, recorded_at, is_current FROM career_history
    WHERE substr(recorded_at,1,10) <= ? ORDER BY recorded_at`).all(AS_OF) as (Career & { constituent_id: number })[]);
  const degrees = byId(db.prepare(`SELECT constituent_id, class_year, degree_type FROM degrees`).all() as (Degree & { constituent_id: number })[]);
  const year = Number(AS_OF.slice(0, 4));
  const activities = byId(db.prepare(`SELECT constituent_id, activity_type, activity_name FROM activities
    WHERE (start_year IS NULL OR start_year <= ?) AND (end_year IS NULL OR end_year >= ?)`)
    .all(year, year) as (Activity & { constituent_id: number })[]);
  return { gifts, interactions, attendance, career, degrees, activities };
}

function main(): void {
  const started = Date.now();
  const frozen = JSON.parse(fs.readFileSync(GOLD_PATH, "utf8")) as GoldContract;
  if (frozen.asOf !== AS_OF || frozen.protocol !== "givecampus-complex-offline-v1" || frozen.queries.length !== 4) {
    throw new Error("Frozen gold contract is missing, unexpected, or changed from the four-query protocol");
  }
  const dbPath = resolveDbPath();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const constituents = db.prepare(`SELECT id, entity_type, deceased, deceased_date, do_not_solicit,
      email_status, phone_status FROM constituents ORDER BY id`).all() as ConstituentEligibilityRow[];
    const affiliationRows = db.prepare(`SELECT constituent_id, affiliation_type FROM affiliations`).all() as
      { constituent_id: number; affiliation_type: string }[];
    const degreeRows = db.prepare(`SELECT constituent_id, class_year, degree_type FROM degrees`).all() as
      { constituent_id: number; class_year: number | null; degree_type: string | null }[];
    const affiliations = byId(affiliationRows);
    const degreesById = byId(degreeRows);
    const eligibility = new Map<number, boolean>();
    const solicitationAllowed = new Map<number, boolean>();
    const eligibleIds: number[] = [];
    for (const constituent of constituents) {
      const result = checkEligibility({
        constituent,
        affiliations: asOfRows(affiliations, constituent.id),
        degrees: asOfRows(degreesById, constituent.id),
        asOf: AS_OF,
      });
      eligibility.set(constituent.id, result.eligibleForContact);
      solicitationAllowed.set(constituent.id, result.eligibleForSolicit);
      if (result.eligibleForContact) eligibleIds.push(constituent.id);
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
    const local = loadLocalVectors(cards, frozen.queries);
    const pre = JSON.parse(fs.readFileSync(PRECOMPUTE_PATH, "utf8")) as {
      verdictsByConstituent: Record<string, Record<string, string>>; mode: string; eligiblePopulation: number;
    };
    const preCoverage = eligibleIds.filter((id) => pre.verdictsByConstituent[String(id)]).length / eligibleIds.length;
    if (preCoverage < 0.999) throw new Error(`Precompute verdict coverage incomplete: ${(preCoverage * 100).toFixed(2)}%`);
    const results = frozen.queries.map((query) => {
      const grades = new Map<number, number>();
      const actions = new Map<string, number>();
      for (const id of eligibleIds) {
        const gold = label(query.id, bundles.get(id)!, solicitationAllowed.get(id) ?? false);
        grades.set(id, gold.grade);
        actions.set(gold.action, (actions.get(gold.action) ?? 0) + 1);
      }
      const docs = cards.map((card) => ({ id: card.constituentId, text: card.searchText }));
      const bm25Started = Date.now();
      const bm25Retrieved = rankBm25(query.query, docs).map((row) => Number(row.id));
      const bm25Seen = new Set(bm25Retrieved);
      const bm25Full = [...bm25Retrieved, ...eligibleIds.filter((id) => !bm25Seen.has(id))];
      const bm25Ms = Date.now() - bm25Started;
      const systems: Record<string, { metrics: Metrics; latencyMs: number }> = {
        bm25: { metrics: metrics(bm25Full, grades), latencyMs: bm25Ms },
      };
      if (local.status.available) {
        const fusedStarted = Date.now();
        const queryVector = local.vectors.get(`query:${hashText(query.query)}`)!;
        const embedded = cards.map((card) => ({
          id: card.constituentId,
          score: cosine(queryVector, local.vectors.get(`card:${card.hash}`)!),
        })).sort((a, b) => b.score - a.score || a.id - b.id).map((r) => r.id);
        systems.semantic = { metrics: metrics(embedded, grades), latencyMs: Date.now() - fusedStarted };
        const fused = reciprocalRankFusion([bm25Retrieved, embedded], 60).map((row) => Number(row.id));
        const fusedSeen = new Set(fused);
        const fusedFull = [...fused, ...eligibleIds.filter((id) => !fusedSeen.has(id))];
        systems.fused_bm25_embedding = { metrics: metrics(fusedFull, grades), latencyMs: Date.now() - fusedStarted };
      }
      // Precompute arm: rank the full eligible population by the Jev-materialized
      // yes/no characteristic vote (no retrieval-time model calls).
      const preStarted = Date.now();
      const weights = PRE_WEIGHTS[query.id] ?? {};
      const preRankedList = [...eligibleIds]
        .map((id) => {
          const verdicts = pre.verdictsByConstituent[String(id)] ?? {};
          let score = 0;
          for (const [qid, weight] of Object.entries(weights)) score += weight * (verdicts[qid] === "yes" ? 1 : 0);
          return { id, score };
        })
        .sort((a, b) => (b.score - a.score) || (a.id - b.id))
        .map((s) => s.id);
      systems.precomputed_characteristics = { metrics: metrics(preRankedList, grades), latencyMs: Date.now() - preStarted };
      const gradeCounts = [0, 1, 2, 3].map((grade) => [...grades.values()].filter((value) => value === grade).length);
      return { id: query.id, gradeCounts, actionCounts: Object.fromEntries([...actions].sort()), systems };
    });
    const report = {
      protocol: frozen.protocol,
      goldSpecSha256: hashText(fs.readFileSync(GOLD_PATH, "utf8")),
      asOf: AS_OF,
      datasetVersion: DATASET_VERSION,
      evidenceVersion: EVIDENCE_VERSION,
      eligibility: "checkEligibility at the same cutoff for all queries; eligibleForContact population; student status only gates ask permission",
      eligibleN: eligibleIds.length,
      allConstituentRows: constituents.length,
      candidatePool: { definition: "the full shared eligible as-of-safe item-card population for each ranker and all queries", size: cards.length, candidateCap: 2000 },
      metrics: { gradedNdcgGain: "2^relevance-1", relevant: "grade > 0", ties: "constituent ID ascending", cutoffs: TOP_K },
      retrieval: {
        bm25: "one exact frozen query string per query; entire shared eligible card set; unmatched rows follow by ID for complete ranking metrics",
        fused: local.status,
        externalRequests: 0,
      },
      queries: results,
      totalRuntimeMs: Date.now() - started,
      outputsContainConstituentIds: false,
      futureOutcomeLabelsLoaded: false,
    };
    fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
    fs.writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const lines = [
      "# Complex Retrieval Benchmark (Offline) + Precomputed Jev Characteristics Arm", "",
      `> Honest scope: the precomputed_characteristics arm ranks by the Jev-materialized yes/no votes from data/characteristics-full (mode=${pre.mode}), whose constituent states were evaluated as-of 2026-08-31 — a YEAR LATER than the 2025-08-31 gold cutoff. The precompute arm is therefore a LEAKY diagnostic; it is not a fair apples-to-apples claim over the other arms. Win or lose, numbers below are computed, not asserted.`, "",
      `Frozen gold specification: [complex-benchmark-gold-v1.json](complex-benchmark-gold-v1.json) (SHA-256 \`${report.goldSpecSha256}\`).`,
      `Cutoff: ${AS_OF}. Shared eligible population and item-card candidate pool: ${eligibleIds.length.toLocaleString()} constituents. No post-cutoff outcomes were loaded. External requests: 0.`,
      `BM25 used the exact query string; absent lexical matches rank last by ID. Embedding fusion: ${local.status.available ? `available from local ${local.status.model} cache only` : `not run (${local.status.reason}; ${local.status.missingCardVectors.toLocaleString()} card vectors and ${local.status.missingQueryVectors} query vectors missing)`}.`,
      "",
      "Recall@100/500/2,000 uses the grade>0 relevant set. NDCG uses graded gain 2^grade-1. P@20 and R@20 are binary grade>0. MRR is the reciprocal rank of the first relevant result. Counts/actions are aggregates only.",
      "",
      "| Query | System | Relevant / N | Recall@100 | Recall@500 | Recall@2k | NDCG@10 | NDCG@20 | P@20 | R@20 | MRR | Hits@20 | Latency ms |",
      "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ];
    for (const result of results) {
      for (const [system, value] of Object.entries(result.systems)) {
        const m = value.metrics;
        lines.push(`| ${result.id} | ${system} | ${m.relevantN} / ${eligibleIds.length} | ${m.recallAt100.toFixed(4)} | ${m.recallAt500.toFixed(4)} | ${m.recallAt2000.toFixed(4)} | ${m.ndcgAt10.toFixed(4)} | ${m.ndcgAt20.toFixed(4)} | ${m.precisionAt20.toFixed(4)} | ${m.recallAt20.toFixed(4)} | ${m.mrr.toFixed(4)} | ${m.hitsAt20} | ${value.latencyMs} |`);
      }
    }
    lines.push("", "## Gold label counts", "", "| Query | Grade 0 | Grade 1 | Grade 2 | Grade 3 |", "|---|---:|---:|---:|---:|");
    for (const result of results) lines.push(`| ${result.id} | ${result.gradeCounts[0]} | ${result.gradeCounts[1]} | ${result.gradeCounts[2]} | ${result.gradeCounts[3]} |`);
    lines.push("", "Action labels are held-out structured reference labels only; no Jev or LLM action evaluation was run. See the JSON for aggregate action counts and cache coverage.", "", `Total runtime: ${report.totalRuntimeMs} ms.`, "");
    fs.writeFileSync(MD_PATH, lines.join("\n"), "utf8");
    console.log(lines.join("\n"));
    console.log(`\nWrote ${path.relative(REPO_ROOT, JSON_PATH)} and ${path.relative(REPO_ROOT, MD_PATH)}.`);
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(`Offline complex benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
