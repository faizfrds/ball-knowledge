/**
 * Deterministic, as-of-date-safe feature calculations.
 * All functions are pure (no DB, no clock): callers pass `asOf = "2026-08-31"`.
 * Rules enforced here mirror DATASET_README interpretation rules:
 * - `status='paid'` is received cash; `recurring_parent` rows are planned
 *   commitments — never add a parent and its installments together.
 * - Ignore any record dated after `asOf` (leakage guard).
 * - `deceased` / `do_not_solicit` are exclusion signals, not rank inputs.
 */

export const DEFAULT_AS_OF = "2026-08-31";

export interface GiftLike {
  id: number;
  gift_date: string; // YYYY-MM-DD
  amount: string | number;
  status: string;
  gift_type: string;
}

export interface InteractionLike {
  id: number;
  occurred_at: string; // ISO timestamp
  follow_up_date?: string | null;
}

export interface AttendanceLike {
  id: number;
  attended_at: string;
}

export interface ConstituentLike {
  id: number;
  deceased: number | boolean;
  do_not_solicit: number | boolean;
  deceased_date?: string | null;
}

export interface EvidenceRef {
  table: string;
  id: number;
}

export function toBool(v: number | boolean): boolean {
  return v === true || v === 1;
}

/** YYYY-MM-DD string compare is chronological; timestamps compare by prefix. */
export function isOnOrBeforeAsOf(dateOrTs: string, asOf: string): boolean {
  return dateOrTs.slice(0, 10) <= asOf;
}

export function daysBetween(aYmd: string, bYmd: string): number {
  const a = Date.parse(`${aYmd}T00:00:00Z`);
  const b = Date.parse(`${bYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function isExcluded(c: ConstituentLike): boolean {
  return toBool(c.deceased) || toBool(c.do_not_solicit);
}

export interface GiftSummary {
  totalPaid: number;
  paidCount: number;
  firstPaidDate: string | null;
  lastPaidDate: string | null;
  daysSinceLastPaid: number | null;
  largestPaidGift: number | null;
  pledgedOutstanding: number;
  evidenceGiftIds: number[];
}

export function summarizeGifts(
  gifts: GiftLike[],
  asOf: string = DEFAULT_AS_OF,
): GiftSummary {
  const inScope = gifts.filter((g) => isOnOrBeforeAsOf(g.gift_date, asOf));
  // Received cash: paid rows excluding recurring_parent commitment headers.
  const paid = inScope.filter(
    (g) => g.status === "paid" && g.gift_type !== "recurring_parent",
  );
  const amounts = paid.map((g) => Number(g.amount));
  const dates = paid.map((g) => g.gift_date).sort();
  const pledgedOutstanding = inScope
    .filter((g) => g.status === "pledged" || g.status === "pending")
    .reduce((s, g) => s + Number(g.amount), 0);
  const last = dates.length > 0 ? dates[dates.length - 1]! : null;
  return {
    totalPaid: round2(amounts.reduce((s, a) => s + a, 0)),
    paidCount: paid.length,
    firstPaidDate: dates.length > 0 ? dates[0]! : null,
    lastPaidDate: last,
    daysSinceLastPaid: last ? daysBetween(last, asOf) : null,
    largestPaidGift: amounts.length > 0 ? Math.max(...amounts) : null,
    pledgedOutstanding: round2(pledgedOutstanding),
    evidenceGiftIds: paid.map((g) => g.id),
  };
}

export interface InteractionSummary {
  totalCount: number;
  lastOccurredAt: string | null;
  daysSinceLast: number | null;
  overdueFollowUps: number;
  evidenceInteractionIds: number[];
}

export function summarizeInteractions(
  interactions: InteractionLike[],
  asOf: string = DEFAULT_AS_OF,
): InteractionSummary {
  const inScope = interactions.filter((i) => isOnOrBeforeAsOf(i.occurred_at, asOf));
  const times = inScope.map((i) => i.occurred_at).sort();
  const last = times.length > 0 ? times[times.length - 1]! : null;
  const overdue = inScope.filter(
    (i) => i.follow_up_date && i.follow_up_date <= asOf,
  ).length;
  return {
    totalCount: inScope.length,
    lastOccurredAt: last,
    daysSinceLast: last ? daysBetween(last.slice(0, 10), asOf) : null,
    overdueFollowUps: overdue,
    evidenceInteractionIds: inScope.map((i) => i.id),
  };
}

export interface ConstituentFeatures extends GiftSummary, InteractionSummary {
  constituentId: number;
  asOf: string;
  excluded: boolean;
  exclusionReason: "deceased" | "do_not_solicit" | null;
  eventAttendanceCount: number;
  evidence: EvidenceRef[];
}

export function buildConstituentFeatures(args: {
  constituent: ConstituentLike;
  gifts: GiftLike[];
  interactions: InteractionLike[];
  attendance: AttendanceLike[];
  asOf?: string;
}): ConstituentFeatures {
  const asOf = args.asOf ?? DEFAULT_AS_OF;
  const gifts = summarizeGifts(args.gifts, asOf);
  const inter = summarizeInteractions(args.interactions, asOf);
  const attInScope = args.attendance.filter((a) => isOnOrBeforeAsOf(a.attended_at, asOf));
  const excluded = isExcluded(args.constituent);
  const reason = toBool(args.constituent.deceased)
    ? "deceased"
    : toBool(args.constituent.do_not_solicit)
      ? "do_not_solicit"
      : null;
  const evidence: EvidenceRef[] = [
    { table: "constituents", id: args.constituent.id },
    ...gifts.evidenceGiftIds.map((id) => ({ table: "gifts", id })),
    ...inter.evidenceInteractionIds.map((id) => ({ table: "interactions", id })),
    ...attInScope.map((a) => ({ table: "event_attendance", id: a.id })),
  ];
  return {
    constituentId: args.constituent.id,
    asOf,
    excluded,
    exclusionReason: reason,
    eventAttendanceCount: attInScope.length,
    evidence,
    ...gifts,
    ...inter,
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
