import type { Criterion } from "./criterion.js";
import { DEFAULT_CRITERION } from "./criterion.js";

/**
 * Priority index (rank-only, 0–100). Weighted sum of capped 0–1 subscores.
 *
 * This is an ordinal worklist rank, NOT a calibrated probability and NOT
 * expected revenue. Callers must label it "priority 0–100 (rank only)".
 *
 * Per-criterion thresholds + explicit unknown state; no product of gate
 * probabilities. Title/employer seniority is weak context only (<=10%).
 */

export interface ScoringGifts {
  paid: { gift_date: string; amount: number }[];
  pledgeHistory: boolean;
  maxSinglePaidEver: number | null;
}

export interface ScoringEngagement {
  eventsAttended2y: number;
  connectedInteractions1y: number;
  distinctActivities: number;
}

export interface ScoringWhyNow {
  recentPaidGift30d: boolean;
  overdueFollowUp: boolean;
  promotionSignal90d: boolean;
  futureEvent30dSameArea: boolean;
  reunionYear: boolean;
}

export interface Subscore {
  value: number | null;
  unknown: boolean;
  label?: string;
}

export interface PriorityScore {
  /** 0–100 rank-only index (null when nothing is known). */
  index: number | null;
  components: Record<"r" | "f" | "m" | "e" | "n" | "c", Subscore>;
  completeness: number;
  unknowns: string[];
  reviewNeeded: boolean;
  reviewReasons: string[];
  dormant: boolean;
}

function ymd(d: string): string {
  return d.slice(0, 10);
}

function addDays(baseYmd: string, days: number): string {
  return new Date(Date.parse(`${baseYmd}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function daysBetween(aYmd: string, bYmd: string): number {
  return Math.round((Date.parse(`${bYmd}T00:00:00Z`) - Date.parse(`${aYmd}T00:00:00Z`)) / 86_400_000);
}

const SENIORITY_RE = /chief|officer|president|partner|founder|director|\bvp\b|vice/i;

export function scorePriority(args: {
  asOf: string;
  gifts: ScoringGifts;
  engagement: ScoringEngagement;
  whyNow: ScoringWhyNow;
  seniorityHint: boolean;
  criterion?: Criterion;
  coldRecord?: boolean;
  stretchAsk?: boolean;
  inactiveFundOnly?: boolean;
}): PriorityScore {
  const c = args.criterion ?? DEFAULT_CRITERION;
  const { asOf } = args;
  const unknowns: string[] = [];
  const reviewReasons: string[] = [];

  // R recency
  let r: Subscore;
  const paidDates = args.gifts.paid.map((g) => ymd(g.gift_date)).sort();
  const lastPaid = paidDates.length > 0 ? paidDates[paidDates.length - 1]! : null;
  if (!lastPaid) {
    r = { value: null, unknown: true, label: `No recorded giving as of ${asOf}` };
    unknowns.push("recency");
  } else {
    const d = Math.max(0, daysBetween(lastPaid, asOf));
    r = { value: 1 / (1 + d / 180), unknown: false };
  }

  // F frequency: paid count in (T0-5y, T0] / 5
  const fiveY = addDays(asOf, -5 * 365);
  const count5y = args.gifts.paid.filter((g) => ymd(g.gift_date) > fiveY && ymd(g.gift_date) <= asOf).length;
  const f: Subscore = { value: Math.min(1, count5y / 5), unknown: false };

  // M monetary: ln(1+total5y)/ln(1+50000)
  const total5y = args.gifts.paid
    .filter((g) => ymd(g.gift_date) > fiveY && ymd(g.gift_date) <= asOf)
    .reduce((s, g) => s + g.amount, 0);
  const m: Subscore = {
    value: Math.min(1, Math.log1p(total5y) / Math.log1p(50000)),
    unknown: false,
  };

  // E engagement
  const eVal = Math.min(
    1,
    (0.5 * args.engagement.eventsAttended2y +
      0.3 * args.engagement.connectedInteractions1y +
      0.2 * args.engagement.distinctActivities) / 3,
  );
  const e: Subscore = {
    value: eVal,
    unknown: eVal === 0 && args.engagement.connectedInteractions1y === 0 && args.engagement.eventsAttended2y === 0,
  };
  if (e.unknown) unknowns.push("engagement");

  // N why-now: max of applicable signals
  const w = args.whyNow;
  let nVal = 0;
  const nParts: string[] = [];
  if (w.recentPaidGift30d) { nVal = Math.max(nVal, 0.9); nParts.push("recent gift"); }
  if (w.overdueFollowUp) { nVal = Math.max(nVal, 0.8); nParts.push("overdue follow-up"); }
  if (w.promotionSignal90d) { nVal = Math.max(nVal, 0.7); nParts.push("promotion signal"); }
  if (w.futureEvent30dSameArea) { nVal = Math.max(nVal, 0.7); nParts.push("nearby event"); }
  if (w.reunionYear) { nVal = Math.max(nVal, 0.6); nParts.push("reunion"); }
  const n: Subscore = { value: nVal, unknown: false, label: nParts.join(", ") || undefined };

  // C capacity proxy: recorded giving first, seniority <= 0.1 contribution.
  const maxSingle = args.gifts.maxSinglePaidEver ?? 0;
  const capGive = Math.min(1, Math.log1p(maxSingle) / Math.log1p(25000));
  const pledgeFlag = args.gifts.pledgeHistory ? 1 : 0;
  const seniorFlag = args.seniorityHint ? 1 : 0;
  const cVal = Math.min(1, 0.7 * capGive + 0.2 * pledgeFlag + 0.1 * seniorFlag);
  const cScore: Subscore = {
    value: cVal,
    unknown: maxSingle === 0 && !args.gifts.pledgeHistory,
  };
  if (cScore.unknown) unknowns.push("capacity");

  const comps = { r, f, m, e, n, c: cScore };
  const weights = c.weights;
  let num = 0;
  let den = 0;
  let known = 0;
  const total = 6;
  for (const k of ["r", "f", "m", "e", "n", "c"] as const) {
    const s = comps[k];
    if (s.value === null || s.unknown) continue;
    num += weights[k] * (s.value as number);
    den += weights[k];
    known += 1;
  }
  const completeness = known / total;
  const index = den > 0 ? Math.round((num / den) * 1000) / 10 : null;

  const dormant =
    !r.unknown && (r.value as number) < c.thresholds.dormantBelow && paidDates.length > 0;
  if (dormant) reviewReasons.push(`no paid gift in 3y as of ${asOf} (dormant)`);
  if (completeness < c.thresholds.reviewBelow) {
    reviewReasons.push(`evidence completeness ${(completeness * 100).toFixed(0)}% below threshold`);
  }
  if (r.unknown && e.unknown) reviewReasons.push("cold record: no giving and no engagement");
  if (args.coldRecord) reviewReasons.push("cold record flag");
  if (args.stretchAsk) reviewReasons.push("stretch ask without supporting evidence — human review");
  if (args.inactiveFundOnly) reviewReasons.push("last designation is a historically inactive fund");

  return {
    index,
    components: comps,
    completeness: Math.round(completeness * 1000) / 1000,
    unknowns,
    reviewNeeded: reviewReasons.length > 0,
    reviewReasons,
    dormant,
  };
}

export function seniorityHintFromTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return SENIORITY_RE.test(title);
}
