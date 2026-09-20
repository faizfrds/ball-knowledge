import type Database from "better-sqlite3";
import { AS_OF_DATE, DATASET_VERSION } from "../config.js";
import {
  DEFAULT_CRITERION,
  EVIDENCE_VERSION,
  criterionHash,
  parseCriterion,
  parseWorklistFilter,
  type Criterion,
  type WorklistFilter,
} from "./criterion.js";
import { checkEligibility } from "./eligibility.js";
import { decideActions, needsResearch, type ActionKind } from "./actions.js";
import { scorePriority, seniorityHintFromTitle } from "./scoring.js";
import { collectEvidence } from "./evidence.js";
import {
  evaluateWithJev,
  minus12mo,
  type JevClient,
  type JevState,
} from "./jev.js";
import { MemoryCache } from "./cache.js";
import {
  FROZEN_RANKING_ID,
  FROZEN_RANKING_VERSION,
  frozenLrRankScore,
} from "./frozen-lr.js";
import {
  getActivities,
  getAffiliations,
  getAttendanceAsOf,
  getCareerAsOf,
  getDegrees,
  getFutureEvents,
  getInteractionsAsOf,
  getPaidGiftsAsOf,
  hasOverdueFollowUp,
  hasPledgeHistory,
  listCandidateConstituents,
  type ConstituentRow,
} from "./store.js";

/**
 * Worklist orchestrator: filter → eligibility → actions → scoring →
 * evidence → (optional Jev enrich) → rank → cost receipt.
 */

export interface WorklistEntry {
  constituentId: number;
  name: string;
  city: string | null;
  state: string | null;
  eligibleForContact: boolean;
  eligibleForSolicit: boolean;
  action: ActionKind;
  alsoConsider: ActionKind[];
  permittedChannel: string;
  /** 0–100 rank-only index (NOT a probability). */
  priorityIndex: number | null;
  /** 1-based global rank under the default frozen ordering. */
  rank: number;
  /** Ordinal rank score in (0,1) from the frozen model — rank only, never probability. */
  rankScore: number;
  /** Ranking method id (always the frozen default unless explicitly overridden). */
  rankingMethod: string;
  completeness: number;
  unknowns: string[];
  reviewNeeded: boolean;
  reviewReasons: string[];
  whyNow: string[];
  evidenceRefs: string[];
  missing: string[];
  jev?: { finalAction?: string; gateOverride?: boolean; cacheHit?: boolean };
}

export interface CostReceipt {
  datasetVersion: string;
  evidenceVersion: string;
  criterionId: string;
  criterionVersion: string;
  criterionHash: string;
  scoringVersion: string;
  /** Default ordering identity: frozen dev-selected ranker (rank only). */
  rankingMethod: string;
  rankingVersion: string;
  asOf: string;
  scanned: number;
  eligible: number;
  ranked: number;
  elapsedMs: number;
  jevCalls: number;
  jevCacheHits: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** LLM explainer usage (explainRanked over final top<=20 only). */
  llmCalls: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmModel: string | null;
  llmFallback: boolean;
}

export interface WorklistResult {
  entries: WorklistEntry[];
  receipt: CostReceipt;
  excluded: number;
}

export const worklistCache = new MemoryCache<import("./jev.js").JevCallResult>(5000);

export function buildJevState(args: {
  row: ConstituentRow;
  asOf: string;
  eligibleForSolicitation: boolean;
  gifts24: { date: string; amount: number }[];
  lifetimeTotal: number | null;
  events: string[];
  title: string | null;
  employer: string | null;
}): JevState {
  const asOf = args.asOf;
  const last = args.gifts24.map((g) => g.date).sort().pop() ?? null;
  return {
    constituent_id: String(args.row.id),
    dataset_version: DATASET_VERSION,
    evidence_version: EVIDENCE_VERSION,
    as_of_date: asOf,
    as_of_date_minus_12mo: minus12mo(asOf),
    permissions: {
      do_not_contact: args.row.do_not_solicit === 1,
      do_not_solicit: args.row.do_not_solicit === 1,
      eligible_for_solicitation: args.eligibleForSolicitation,
    },
    recorded_giving: {
      last_gift_date: last,
      last_gift_amount: args.gifts24.length > 0 ? args.gifts24[args.gifts24.length - 1]!.amount : null,
      lifetime_total: args.lifetimeTotal,
      gift_count_24mo: args.gifts24.length,
    },
    engagement: { events: args.events.slice(0, 12) },
    explicit_capacity: { rating: null, source: null },
    context: { title: args.title, employer: args.employer },
  };
}

function earliestUgDegree(degrees: { degree_type: string | null; class_year: number | null }[]): number | null {
  const ug = degrees.filter(
    (d) =>
      d.class_year != null &&
      d.degree_type != null &&
      ["B.A.", "A.B.", "B.S.", "B.B.A."].includes(d.degree_type),
  );
  if (ug.length === 0) return null;
  return Math.min(...ug.map((d) => d.class_year as number));
}

export async function buildWorklist(
  db: Database.Database,
  filterInput: unknown,
  criterionInput: unknown = undefined,
  opts: { jevClient?: JevClient; enrichWithJev?: boolean; scanLimit?: number } = {},
): Promise<WorklistResult> {
  const t0 = Date.now();
  const filter: WorklistFilter = parseWorklistFilter(filterInput);
  const criterion: Criterion = parseCriterion(criterionInput ?? DEFAULT_CRITERION);
  const asOf = filter.asOf || AS_OF_DATE;
  const futureEvents = getFutureEvents(db, asOf);
  const candidates = listCandidateConstituents(db, filter, opts.scanLimit ?? 4000);

  const entries: WorklistEntry[] = [];
  let excluded = 0;
  let jevCalls = 0;
  let jevCacheHits = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const row of candidates) {
    const affiliations = getAffiliations(db, row.id);
    const degrees = getDegrees(db, row.id);
    const elig = checkEligibility({
      constituent: {
        id: row.id,
        entity_type: row.entity_type,
        deceased: row.deceased,
        deceased_date: row.deceased_date,
        do_not_solicit: row.do_not_solicit,
        email_status: row.email_status,
        phone_status: row.phone_status,
      },
      affiliations: affiliations.map((a) => ({ affiliation_type: a.affiliation_type })),
      degrees: degrees.map((d) => ({ class_year: d.class_year, degree_type: d.degree_type })),
      asOf,
    });
    if (!elig.eligibleForContact) {
      excluded += 1;
      continue;
    }

    const gifts = getPaidGiftsAsOf(db, row.id, asOf);
    const paidOnly = gifts.filter((g) => g.status === "paid" && g.gift_type !== "recurring_parent");
    const inters = getInteractionsAsOf(db, row.id, asOf);
    const att = getAttendanceAsOf(db, row.id, asOf);
    const acts = getActivities(db, row.id);
    const career = getCareerAsOf(db, row.id, asOf);

    const decision = decideActions({
      eligibility: elig,
      gifts: paidOnly.map((g) => ({ id: g.id, gift_date: g.gift_date, amount: g.amount, status: g.status, gift_type: g.gift_type })),
      interactions: inters.map((i) => ({
        id: i.id,
        occurred_at: i.occurred_at,
        purpose: i.purpose,
        outcome: i.outcome,
        direction: i.direction,
        follow_up_date: i.follow_up_date,
        related_gift_id: i.related_gift_id,
      })),
      futureEvents: futureEvents.map((e) => ({ id: e.id, starts_at: e.starts_at })),
      asOf,
      constituentId: row.id,
    });

    // Why-now inputs (all as-of bounded).
    const d30 = new Date(Date.parse(`${asOf}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    const d90 = new Date(Date.parse(`${asOf}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
    const recentPaid = paidOnly.some((g) => g.gift_date.slice(0, 10) > d30);
    const promo = career.some(
      (cr) => cr.recorded_at.slice(0, 10) > d90 && cr.is_current === 1,
    );
    const nearbyEvent = futureEvents.some(
      (e) =>
        e.starts_at.slice(0, 10) <= new Date(Date.parse(`${asOf}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10) &&
        ((row.city && e.city === row.city) || (row.state && e.state === row.state)),
    );
    const ugYear = earliestUgDegree(degrees);
    const reunion = ugYear !== null && (Number(asOf.slice(0, 4)) - ugYear) % 5 === 0;
    const overdue = hasOverdueFollowUp(inters, asOf);

    const twoY = new Date(Date.parse(`${asOf}T00:00:00Z`) - 2 * 365 * 86_400_000).toISOString().slice(0, 10);
    const oneY = new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
    const ev2y = att.filter((a) => a.attended_at.slice(0, 10) > twoY).length;
    const conn1y = inters.filter(
      (i) =>
        i.occurred_at.slice(0, 10) > oneY &&
        ["connected", "replied", "meeting_booked", "gift_received", "pledged"].includes(i.outcome),
    ).length;
    const currentTitle = career.filter((cr) => cr.is_current === 1).map((cr) => cr.job_title).pop() ?? null;
    const currentEmployer = career.filter((cr) => cr.is_current === 1).map((cr) => cr.employer).pop() ?? null;
    const pledgeHist = hasPledgeHistory(db, row.id, asOf);
    const maxSingle = paidOnly.length > 0 ? Math.max(...paidOnly.map((g) => g.amount)) : null;
    const score = scorePriority({
      asOf,
      gifts: {
        paid: paidOnly.map((g) => ({ gift_date: g.gift_date, amount: g.amount })),
        pledgeHistory: pledgeHist,
        maxSinglePaidEver: maxSingle,
      },
      engagement: {
        eventsAttended2y: ev2y,
        connectedInteractions1y: conn1y,
        distinctActivities: new Set(acts.map((a) => a.activity_name)).size,
      },
      whyNow: {
        recentPaidGift30d: recentPaid,
        overdueFollowUp: overdue,
        promotionSignal90d: promo,
        futureEvent30dSameArea: nearbyEvent,
        reunionYear: reunion,
      },
      seniorityHint: seniorityHintFromTitle(currentTitle),
      criterion,
      coldRecord: paidOnly.length === 0 && inters.length === 0,
    });

    const research = needsResearch({
      city: row.city,
      paidCount: paidOnly.length,
      interactionCount: inters.length,
      classYearMissingWithAlumniAffil: affiliations.some((a) =>
        ["alumni", "alumnus", "alumna"].includes(a.affiliation_type.toLowerCase()),
      ) && degrees.every((d) => d.class_year == null),
    });
    const gaps: string[] = [...research.reasons];
    if (paidOnly.length === 0) gaps.push("no recorded paid gifts");
    if (inters.length === 0) gaps.push("no recorded interactions");
    if (att.length === 0) gaps.push("no event attendance");
    if (elig.affiliationMissing) gaps.push("missing affiliation (intentional gap set)");
    const ev = collectEvidence({
      asOf,
      constituentId: row.id,
      giftIds: paidOnly.map((g) => g.id),
      lastGift: paidOnly.length > 0
        ? {
            id: paidOnly[paidOnly.length - 1]!.id,
            gift_date: paidOnly[paidOnly.length - 1]!.gift_date,
            amount: paidOnly[paidOnly.length - 1]!.amount,
          }
        : null,
      interactionIds: inters.map((i) => i.id),
      attendanceIds: att.map((a) => a.id),
      careerIds: career.map((cr) => cr.id),
      degreeInfo: ugYear !== null ? `earliest UG ${ugYear}` : null,
      activityNames: [...new Set(acts.map((a) => a.activity_name))].slice(0, 8),
      gaps,
    });

    const whyNow: string[] = [];
    if (recentPaid) whyNow.push("paid gift in last 30d");
    if (overdue) whyNow.push("overdue follow-up");
    if (promo) whyNow.push("recent promotion signal");
    if (nearbyEvent) whyNow.push("nearby event within 30d");
    if (reunion) whyNow.push(`reunion class of ${ugYear}`);

    let action = decision.action;
    const alsoConsider = decision.permitted.filter((a) => a !== action);
    if (research.needed && !alsoConsider.includes("research")) alsoConsider.push("research");
    const reviewNeeded = score.reviewNeeded || action === "review_needed";
    const reviewReasons = [...score.reviewReasons];
    if (action === "review_needed" && !reviewNeeded) reviewReasons.push("no permitted action — human review");

    // Optional Jev enrichment: advisory only, never overrides code gates.
    let jev: WorklistEntry["jev"];
    if (opts.enrichWithJev) {
      const twoYg = paidOnly.filter((g) => g.gift_date.slice(0, 10) > addYears(asOf, -2));
      const state = buildJevState({
        row,
        asOf,
        eligibleForSolicitation: elig.eligibleForSolicit,
        gifts24: twoYg.map((g) => ({ date: g.gift_date.slice(0, 10), amount: g.amount })),
        lifetimeTotal: paidOnly.reduce((s, g) => s + g.amount, 0) || null,
        events: [
          ...inters.slice(-6).map((i) => `${i.purpose}:${i.outcome} ${i.occurred_at.slice(0, 10)}`),
          ...att.slice(-4).map((a) => `attended event ${a.event_id}`),
        ],
        title: currentTitle,
        employer: currentEmployer,
      });
      const out = await evaluateWithJev(state, {
        client: opts.jevClient,
        cache: worklistCache,
        eligibleForSolicitation: elig.eligibleForSolicit,
      });
      if (out.available && out.result) {
        jevCalls += 1;
        if (out.result.cacheHit) jevCacheHits += 1;
        inputTokens += out.result.usage.input_tokens;
        outputTokens += out.result.usage.output_tokens;
        jev = { finalAction: out.finalAction, gateOverride: out.gateOverride, cacheHit: out.result.cacheHit };
        if (out.gateOverride) reviewReasons.push("model suggested a code-forbidden action — held for review");
      }
    }

    // Default ordering: frozen dev-selected logistic ranker over the six
    // code priority subscores (unknowns -> 0, matching benchmark treatment).
    // Deterministic eligibility/actions/evidence above are untouched; the
    // 0–100 priority index is retained per row for display. rankScore is
    // ORDINAL rank-only, never a probability.
    const rankScore = frozenLrRankScore({
      r: score.components.r.value ?? 0,
      f: score.components.f.value ?? 0,
      m: score.components.m.value ?? 0,
      e: score.components.e.value ?? 0,
      n: score.components.n.value ?? 0,
      c: score.components.c.value ?? 0,
    });

    entries.push({
      constituentId: row.id,
      name: row.preferred_name,
      city: row.city,
      state: row.state,
      eligibleForContact: elig.eligibleForContact,
      eligibleForSolicit: elig.eligibleForSolicit,
      action: reviewNeeded && action !== "excluded" && score.completeness < criterion.thresholds.reviewBelow
        ? "review_needed"
        : action,
      alsoConsider,
      permittedChannel: decision.permittedChannel ?? "none",
      priorityIndex: score.index,
      rank: 0, // assigned after the frozen-order sort below
      rankScore,
      rankingMethod: FROZEN_RANKING_ID,
      completeness: score.completeness,
      unknowns: score.unknowns,
      reviewNeeded,
      reviewReasons,
      whyNow,
      evidenceRefs: ev.refs,
      missing: ev.missing,
      jev,
    });
  }

  // Default order: frozen rank score desc; ties break by constituent id
  // ascending (ids are permuted — tiebreak only). Rank is global (1-based)
  // so paged responses keep stable positions.
  entries.sort((a, b) => (b.rankScore !== a.rankScore ? b.rankScore - a.rankScore : a.constituentId - b.constituentId));
  entries.forEach((e, i) => {
    e.rank = i + 1;
  });
  const total = entries.length;
  const paged = entries.slice(filter.offset, filter.offset + filter.limit);
  void total;
  const receipt: CostReceipt = {
    datasetVersion: DATASET_VERSION,
    evidenceVersion: EVIDENCE_VERSION,
    criterionId: criterion.id,
    criterionVersion: criterion.version,
    criterionHash: criterionHash(criterion),
    scoringVersion: criterion.scoringVersion,
    rankingMethod: FROZEN_RANKING_ID,
    rankingVersion: FROZEN_RANKING_VERSION,
    asOf,
    scanned: candidates.length,
    eligible: entries.length,
    ranked: paged.length,
    elapsedMs: Date.now() - t0,
    jevCalls,
    jevCacheHits,
    inputTokens,
    outputTokens,
    model: "jev-1.13.0",
    llmCalls: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    llmModel: null,
    llmFallback: false,
  };
  return { entries: paged, receipt, excluded };
}

function addYears(asOf: string, years: number): string {
  const d = new Date(Date.parse(`${asOf}T00:00:00Z`));
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
