import type { EligibilityResult } from "./eligibility.js";

/**
 * Deterministic action permissions (A-rules).
 *
 * Allow/deny per action computed in code BEFORE ranking and BEFORE any
 * model judgment. A Jev `permitted_action` Choice is advisory only and
 * MUST NOT override these gates — code is authoritative.
 */

export type ActionKind =
  | "thank"
  | "invite"
  | "solicit"
  | "cultivate"
  | "research"
  | "review_needed"
  | "excluded";

export interface PaidGiftLite {
  id: number;
  gift_date: string;
  amount: number;
  status: string;
  gift_type: string;
}

export interface InteractionLite {
  id: number;
  occurred_at: string;
  purpose: string;
  outcome: string;
  direction: string;
  follow_up_date?: string | null;
  related_gift_id?: number | null;
}

export interface FutureEventLite {
  id: number;
  starts_at: string;
}

export interface ActionDecision {
  action: ActionKind;
  permitted: ActionKind[];
  reasons: string[];
  permittedChannel?: "email" | "phone" | "either" | "none";
}

function ymd(ts: string): string {
  return ts.slice(0, 10);
}

function addDays(baseYmd: string, days: number): string {
  const t = Date.parse(`${baseYmd}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const TIE_BREAK: ActionKind[] = ["thank", "invite", "solicit", "cultivate", "research"];

export function decideActions(args: {
  eligibility: EligibilityResult;
  gifts: PaidGiftLite[];
  interactions: InteractionLite[];
  futureEvents?: FutureEventLite[];
  asOf: string;
  constituentCity?: string | null;
  constituentId?: number;
}): ActionDecision {
  const { eligibility: elig, asOf } = args;
  const gifts = (args.gifts ?? []).filter(
    (g) => g.status === "paid" && g.gift_type !== "recurring_parent" && ymd(g.gift_date) <= asOf,
  );
  const inters = (args.interactions ?? []).filter((i) => ymd(i.occurred_at) <= asOf);
  const futureEvents = (args.futureEvents ?? []).filter((e) => e.starts_at.slice(0, 10) > asOf);
  const reasons: string[] = [];

  // Suppressed/deceased/org => excluded, never ranked.
  if (!elig.gates.find((g) => g.gate === "E1.person_alive")?.pass) {
    return { action: "excluded", permitted: [], reasons: ["E1.person_alive failed (deceased)"] };
  }
  if (!elig.gates.find((g) => g.gate === "E2.not_suppressed")?.pass) {
    return { action: "excluded", permitted: [], reasons: ["E2.not_suppressed failed (do_not_solicit)"] };
  }
  if (!elig.gates.find((g) => g.gate === "E5.person_only")?.pass) {
    return { action: "excluded", permitted: [], reasons: ["E5.person_only failed (organization)"] };
  }
  if (!elig.eligibleForContact) {
    return {
      action: "review_needed",
      permitted: [],
      reasons: ["not eligible for contact (unreachable); research/review only"],
      permittedChannel: "none",
    };
  }

  const permitted: ActionKind[] = [];
  const channel: "email" | "phone" | "either" | "none" = elig.emailOk && elig.phoneOk
    ? "either"
    : elig.emailOk
      ? "email"
      : elig.phoneOk
        ? "phone"
        : "none";

  // A-THANK: paid gift in (T0-90d, T0] with no later acknowledgement.
  const window90 = addDays(asOf, -90);
  const recentGifts = gifts.filter((g) => ymd(g.gift_date) > window90 && ymd(g.gift_date) <= asOf);
  const thankedGiftIds = new Set(
    inters
      .filter((i) => i.purpose === "acknowledgement" && i.related_gift_id != null)
      .map((i) => i.related_gift_id as number),
  );
  const unthanked = recentGifts.filter((g) => !thankedGiftIds.has(g.id));
  if (unthanked.length > 0) {
    permitted.push("thank");
    reasons.push(`thank: ${unthanked.length} unacknowledged paid gift(s) in last 90d (e.g. gifts:${unthanked[0]!.id})`);
  }

  // A-INVITE: future event exists + reachable.
  if (futureEvents.length > 0) {
    permitted.push("invite");
    reasons.push(`invite: ${futureEvents.length} future event(s) after ${asOf} (e.g. events:${futureEvents[0]!.id})`);
  }

  // A-SOLICIT: eligible + channel + no fatigue + no open-ask collision.
  const solicitFatigue = inters.filter(
    (i) => i.purpose === "solicitation" && ymd(i.occurred_at) > addDays(asOf, -30),
  );
  const openCollision = inters.filter(
    (i) =>
      i.purpose === "solicitation" &&
      (i.outcome === "pledged" || i.outcome === "meeting_booked") &&
      i.follow_up_date != null &&
      i.follow_up_date.slice(0, 10) >= asOf,
  );
  if (!elig.eligibleForSolicit) {
    reasons.push(
      elig.isCurrentStudent
        ? "solicit denied: current student (invite/cultivate only)"
        : "solicit denied: not solicit-eligible",
    );
  } else if (channel === "none") {
    reasons.push("solicit denied: no permitted channel");
  } else if (solicitFatigue.length > 0) {
    reasons.push(`solicit denied: ${solicitFatigue.length} solicitation(s) in last 30d (fatigue)`);
  } else if (openCollision.length > 0) {
    reasons.push("solicit denied: open ask collision (pledged/meeting_booked with follow_up >= T0)");
  } else {
    permitted.push("solicit");
    reasons.push(`solicit permitted via ${channel}`);
  }

  // A-CULTIVATE: contact-eligible, lapsed/never-contacted, not thank-eligible, not fatigued.
  const connected = inters.filter((i) =>
    ["connected", "replied", "meeting_booked", "gift_received", "pledged"].includes(i.outcome),
  );
  const lastConnected = connected.map((i) => ymd(i.occurred_at)).sort().pop() ?? null;
  const lapsed = lastConnected === null || lastConnected <= addDays(asOf, -90);
  if (lapsed && unthanked.length === 0 && solicitFatigue.length === 0) {
    permitted.push("cultivate");
    reasons.push(
      lastConnected ? `cultivate: last connected contact ${lastConnected} (>90d ago)` : "cultivate: never contacted",
    );
  }

  const top = TIE_BREAK.find((a) => permitted.includes(a));
  if (!top) {
    return { action: "review_needed", permitted, reasons, permittedChannel: channel };
  }
  // Surface research as an "also consider" hint, not the headline, when
  // permitted list is otherwise non-empty — caller appends via evidence gaps.
  return { action: top, permitted, reasons, permittedChannel: channel };
}

/** Research/data-update eligibility (key-field gaps), computed alongside actions. */
export function needsResearch(args: {
  city?: string | null;
  paidCount: number;
  interactionCount: number;
  classYearMissingWithAlumniAffil?: boolean;
  careerConflict?: boolean;
}): { needed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (args.city == null || args.city === "") reasons.push("missing city (location gap)");
  if (args.paidCount === 0 && args.interactionCount === 0) reasons.push("cold record (no gifts, no interactions)");
  if (args.classYearMissingWithAlumniAffil) reasons.push("alumni affiliation without class_year");
  if (args.careerConflict) reasons.push("conflicting career dates (outside board/advisory tolerance)");
  return { needed: reasons.length > 0, reasons };
}
