/**
 * Characteristic yes/no (noul) question library for GiveCampus Jev precomputation.
 *
 * Simulates the "last 100 requests" contract: a deterministic bank of exactly
 * 100 yes/no constituent characteristics (giving recency/frequency/bands,
 * engagement, event attendance, career, permissions, compounds). Each maps to
 * one Jev noul question over the standard as-of-safe Jev state
 * (see buildJevStateForId), so answers can be precomputed and cached offline.
 *
 * Every characteristic also carries a deterministic code mirror (`codeCheck`)
 * used ONLY for mock/simulation mode and tests — never a substitute for live
 * Jev in benchmark claims.
 */
import type { JevQuestion, JevState } from "../givecampus/jev.js";

export interface CharacteristicQuestion {
  id: string;
  question: JevQuestion;
  /** Deterministic code mirror: true/false from the listed state; null = unknown evidence. */
  codeCheck: (state: JevState) => boolean | null;
}

export const CHARACTERISTIC_COUNT = 100;

function noul(
  id: string,
  instructions: string,
  yes: string,
  no: string,
  codeCheck: (state: JevState) => boolean | null,
): CharacteristicQuestion {
  return { id, question: { type: "noul", instructions, criteria: { true: yes, false: no } }, codeCheck };
}

function dayDiff(asOf: string, date: string): number {
  return Math.round((Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - Date.parse(`${date.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

function lastGiftAgeDays(state: JevState): number | null {
  const d = state.recorded_giving.last_gift_date;
  if (d == null) return null;
  return dayDiff(state.as_of_date, d);
}

function lifetime(state: JevState): number {
  const v = state.recorded_giving.lifetime_total;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function giftCount24mo(state: JevState): number {
  const v = state.recorded_giving.gift_count_24mo;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** events entries: interactions "purpose:outcome YYYY-MM-DD", attendance "attended event <id>". */
function eventDates(state: JevState): number[] {
  return state.engagement.events
    .map((e) => /\b(\d{4}-\d{2}-\d{2})\b/.exec(e)?.[1])
    .filter((d): d is string => d != null)
    .map((d) => Date.parse(`${d}T00:00:00Z`))
    .filter((t) => Number.isFinite(t));
}

function isEventAttendance(e: string): boolean {
  return /^attended event\b/i.test(e);
}

const CONNECTED_OUTCOMES = ["connected", "replied", "meeting_booked", "gift_received", "pledged"] as const;

function connectedWithin(state: JevState, days: number): boolean {
  const cutoff = Date.parse(`${state.as_of_date.slice(0, 10)}T00:00:00Z`) - days * 86_400_000;
  return state.engagement.events.some((e) => {
    const m = /^([^:]+):([^ ]+) (\d{4}-\d{2}-\d{2})$/.exec(e);
    if (!m) return false;
    if (!(CONNECTED_OUTCOMES as readonly string[]).includes(m[2]!.toLowerCase())) return false;
    return Date.parse(`${m[3]}T00:00:00Z`) >= cutoff;
  });
}

function titleIs(state: JevState, needles: string[]): boolean | null {
  const t = state.context.title;
  if (t == null) return null;
  const low = t.toLowerCase();
  return needles.some((n) => low.includes(n));
}

const BASE = {
  gaveWithin: (state: JevState, days: number): boolean | null => {
    const age = lastGiftAgeDays(state);
    return age == null ? false : age <= days;
  },
  lapsedOver: (state: JevState, days: number): boolean | null => {
    const age = lastGiftAgeDays(state);
    return age == null ? false : age > days;
  },
  neverGave: (state: JevState): boolean => lastGiftAgeDays(state) == null && lifetime(state) <= 0,
  giftsAtLeast: (state: JevState, k: number): boolean => giftCount24mo(state) >= k,
  giftsUnder: (state: JevState, k: number): boolean => giftCount24mo(state) < k,
  lifetimeAtLeast: (state: JevState, x: number): boolean => lifetime(state) >= x,
  lifetimeUnder: (state: JevState, x: number): boolean => lifetime(state) < x,
  lastAmountAtLeast: (state: JevState, a: number): boolean | null => {
    const v = state.recorded_giving.last_gift_amount;
    return v == null ? false : Number(v) >= a;
  },
  lastAmountUnder: (state: JevState, a: number): boolean | null => {
    const v = state.recorded_giving.last_gift_amount;
    return v == null ? false : Number(v) < a;
  },
  eventCount: (state: JevState): number => state.engagement.events.length,
  attendanceCount: (state: JevState): number => state.engagement.events.filter(isEventAttendance).length,
  volunteerish: (state: JevState): boolean =>
    state.engagement.events.some((e) => /volunteer|chair|host|committee|leadership/i.test(e)),
  giftReceivedInteraction: (state: JevState): boolean =>
    state.engagement.events.some((e) => { const m = /:([^ ]+) /.exec(e); return m != null && m[1] === "gift_received"; }),
};

export function buildCharacteristicQuestions(): CharacteristicQuestion[] {
  const out: CharacteristicQuestion[] = [];

  // A. Giving recency windows (15)
  for (const days of [7, 14, 30, 60, 90, 120, 180, 270, 365, 545, 730, 1095, 1460, 1825, 2555]) {
    out.push(
      noul(
        `gave_within_${days}d`,
        `Did ` +
          "`recorded_giving.last_gift_date`" +
          ` occur within the last ${days} days before ` +
          "`as_of_date`" +
          "? Compute the cutoff date as as_of_date minus " +
          `${days} days; compare dates only.`,
        `Yes: last_gift_date is listed and is on or after as_of_date minus ${days} days.`,
        `No: no last_gift_date is listed, or the last gift is older than as_of_date minus ${days} days.`,
        (s) => BASE.gaveWithin(s, days),
      ),
    );
  }

  // B. Never gave (1)
  out.push(
    noul(
      "never_gave",
      "Did this constituent ever give on record? Check `recorded_giving.lifetime_total` and `recorded_giving.last_gift_date`.",
      "Yes: no lifetime_total and no last_gift_date are listed (never gave on record).",
      "No: a lifetime_total or last_gift_date is present (they have given before).",
      (s) => BASE.neverGave(s),
    ),
  );

  // C. Frequency at least K in 24 months (8) — K 1..8
  for (let k = 1; k <= 8; k++) {
    out.push(
      noul(
        `gifts_24mo_at_least_${k}`,
        "Does `recorded_giving.gift_count_24mo` list at least " + `${k} gifts?`,
        `Yes: gift_count_24mo >= ${k}.`,
        `No: gift_count_24mo is missing or < ${k}.`,
        (s) => BASE.giftsAtLeast(s, k),
      ),
    );
  }

  // D. Lifetime bands at least X (11)
  for (const x of [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000]) {
    out.push(
      noul(
        `lifetime_at_least_${x}`,
        "Is `recorded_giving.lifetime_total` at least $" + `${x}?`,
        `Yes: lifetime_total >= ${x}.`,
        `No: lifetime_total is missing or < ${x}.`,
        (s) => BASE.lifetimeAtLeast(s, x),
      ),
    );
  }

  // E. Last gift amount at least A (6)
  for (const a of [50, 100, 250, 500, 1000, 5000]) {
    out.push(
      noul(
        `last_gift_at_least_${a}`,
        "Is the most recent recorded gift amount `recorded_giving.last_gift_amount` at least $" + `${a}?`,
        `Yes: last_gift_amount >= ${a}.`,
        `No: last_gift_amount is missing or < ${a}.`,
        (s) => BASE.lastAmountAtLeast(s, a),
      ),
    );
  }

  // F. Lapsed windows (4)
  for (const days of [365, 730, 1095, 1825]) {
    out.push(
      noul(
        `lapsed_over_${days}d`,
        "Was the last recorded gift more than " +
          `${days} days before ` +
          "`as_of_date" +
          "` (i.e., previously gave but not recently)? A last_gift_date must be present.",
        `Yes: last_gift_date is listed and is more than ${days} days before as_of_date.`,
        "No: no last_gift_date is listed (never gave), or the last gift is within the window.",
        (s) => BASE.lapsedOver(s, days),
      ),
    );
  }

  // G. Engagement volume (3)
  out.push(
    noul(
      "any_engagement_events",
      "Does `engagement.events` list at least one interaction or event attendance?",
      "Yes: at least one entry is listed in engagement.events.",
      "No: engagement.events is empty.",
      (s) => BASE.eventCount(s) >= 1,
    ),
  );
  out.push(
    noul(
      "multiple_engagement_events",
      "Does `engagement.events` list at least two entries (interactions or attendance)?",
      "Yes: two or more entries are listed.",
      "No: fewer than two entries are listed.",
      (s) => BASE.eventCount(s) >= 2,
    ),
  );
  out.push(
    noul(
      "frequent_engagement_events",
      "Does `engagement.events` list at least four entries (interactions or attendance)?",
      "Yes: four or more entries are listed.",
      "No: fewer than four entries are listed.",
      (s) => BASE.eventCount(s) >= 4,
    ),
  );

  // H. Career context presence (3)
  out.push(
    noul(
      "title_present",
      "Is a `context.title` string listed? Presence only — do not infer wealth from the title.",
      "Yes: a title string is listed in context.",
      "No: context.title is missing or empty.",
      (s) => (s.context.title == null ? false : true),
    ),
  );
  out.push(
    noul(
      "employer_present",
      "Is a `context.employer` string listed? Presence does NOT indicate wealth or capacity.",
      "Yes: an employer string is listed in context.",
      "No: context.employer is missing or empty.",
      (s) => (s.context.employer == null ? false : true),
    ),
  );
  out.push(
    noul(
      "context_present_either",
      "Is either `context.title` or `context.employer` listed?",
      "Yes: a title or employer string is listed.",
      "No: neither is listed.",
      (s) => (s.context.title == null && s.context.employer == null ? false : true),
    ),
  );

  // I. Senior/leadership title keywords (8)
  for (const kw of ["chief", "officer", "president", "partner", "founder", "director", "vice", "head"]) {
    out.push(
      noul(
        `title_has_${kw}`,
        "Does `context.title` (case-insensitive) contain the word " +
          `'${kw}'` +
          "? Answer from the listed title only; a missing title is not a yes.",
        `Yes: the listed title contains '${kw}'.`,
        `No: no title is listed, or it does not contain '${kw}'.`,
        (s) => titleIs(s, [kw]) ?? false,
      ),
    );
  }

  // J. Permissions (2)
  out.push(
    noul(
      "eligible_for_solicitation",
      "Does `permissions.eligible_for_solicitation` read true?",
      "Yes: the state lists eligible_for_solicitation true and do_not_solicit/do_not_contact are false.",
      "No: any listed permission restricts solicitation.",
      (s) => s.permissions.eligible_for_solicitation,
    ),
  );
  out.push(
    noul(
      "do_not_contact",
      "Does `permissions.do_not_contact` read true?",
      "Yes: do_not_contact is true.",
      "No: do_not_contact is false.",
      (s) => s.permissions.do_not_contact,
    ),
  );

  // K. Small last-gift amounts (5)
  for (const a of [50, 100, 250, 500, 1000]) {
    out.push(
      noul(
        `last_gift_under_${a}`,
        "Is the most recent recorded gift amount `recorded_giving.last_gift_amount` under $" + `${a}?`,
        `Yes: last_gift_amount is listed and < ${a}.`,
        `No: last_gift_amount is missing, or >= ${a}.`,
        (s) => BASE.lastAmountUnder(s, a),
      ),
    );
  }

  // L. Small lifetime totals (3)
  for (const x of [500, 1000, 5000]) {
    out.push(
      noul(
        `lifetime_under_${x}`,
        "Is `recorded_giving.lifetime_total` under $" + `${x}?`,
        `Yes: lifetime_total is missing or < ${x}.`,
        `No: lifetime_total >= ${x}.`,
        (s) => BASE.lifetimeUnder(s, x),
      ),
    );
  }

  // M. Few gifts in 24 months (3)
  for (let k = 1; k <= 3; k++) {
    out.push(
      noul(
        `gifts_24mo_under_${k}`,
        "Does `recorded_giving.gift_count_24mo` show fewer than " + `${k} gifts?`,
        `Yes: gift_count_24mo is missing or < ${k}.`,
        `No: gift_count_24mo >= ${k}.`,
        (s) => BASE.giftsUnder(s, k),
      ),
    );
  }

  // N. Any recorded interaction recency (3)
  for (const days of [90, 180, 365]) {
    out.push(
      noul(
        `engagement_within_${days}d`,
        "Does `engagement.events` list any interaction dated within the last " +
          `${days} days before ` +
          "`as_of_date" +
          "`? Event entries carry dates as strings.",
        `Yes: at least one dated interaction within as_of_date minus ${days} days.`,
        `No: no interaction dates listed within the window.`,
        (s) => {
          const cutoff = Date.parse(`${s.as_of_date.slice(0, 10)}T00:00:00Z`) - days * 86_400_000;
          return eventDates(s).some((t) => t >= cutoff);
        },
      ),
    );
  }

  // O. Event attendance (3)
  out.push(
    noul(
      "attended_event",
      "Does `engagement.events` list any event attendance (entries like 'attended event <id>')? Answer only from listed entries.",
      "Yes: at least one attendance entry is listed.",
      "No: no attendance entries are listed.",
      (s) => s.engagement.events.some(isEventAttendance),
    ),
  );
  out.push(
    noul(
      "attended_events_at_least_2",
      "Does `engagement.events` list two or more event attendance entries?",
      "Yes: two or more attendance entries are listed.",
      "No: fewer than two attendance entries are listed.",
      (s) => s.engagement.events.filter(isEventAttendance).length >= 2,
    ),
  );
  out.push(
    noul(
      "volunteer_or_leadership_role",
      "Do any `engagement.events` entries indicate a volunteer, host, chair, committee, or leadership role? Answer from the listed text only.",
      "Yes: at least one entry indicates a volunteer/leadership role.",
      "No: no entry indicates such a role.",
      (s) => BASE.volunteerish(s),
    ),
  );

  // P. Connected interactions recency (3)
  for (const days of [90, 180, 365]) {
    out.push(
      noul(
        `connected_within_${days}d`,
        "`engagement.events` lists interactions as 'purpose:outcome date' strings. Is any listed interaction with outcome connected, replied, meeting_booked, gift_received, or pledged dated within the last " +
          `${days} days before ` +
          "`as_of_date" +
          "`?",
        `Yes: a connected-type interaction is listed within as_of_date minus ${days} days.`,
        `No: no such listed interaction within the window.`,
        (s) => connectedWithin(s, days),
      ),
    );
  }

  // Q. Gift-received interaction ever (1)
  out.push(
    noul(
      "gift_received_interaction",
      "Does `engagement.events` list an interaction with outcome gift_received?",
      "Yes: at least one gift_received interaction is listed.",
      "No: no gift_received interaction is listed.",
      (s) => BASE.giftReceivedInteraction(s),
    ),
  );

  // R. Compound judgment characteristics (9)
  out.push(
    noul(
      "engaged_recent_donor",
      "Answer yes only if BOTH: (1) `recorded_giving.last_gift_date` is within 90 days before `as_of_date`, AND (2) `recorded_giving.gift_count_24mo` is at least 2.",
      "Yes: both conditions hold.",
      "No: either condition fails.",
      (s) => (BASE.gaveWithin(s, 90) && BASE.giftsAtLeast(s, 2) ? true : false),
    ),
  );
  out.push(
    noul(
      "recent_giver_engaged",
      "Answer yes only if BOTH: (1) `recorded_giving.last_gift_date` is within 365 days before `as_of_date`, AND (2) `engagement.events` lists at least one entry.",
      "Yes: both conditions hold.",
      "No: either condition fails.",
      (s) => (BASE.gaveWithin(s, 365) && BASE.eventCount(s) >= 1 ? true : false),
    ),
  );
  out.push(
    noul(
      "recent_giver_mid_capacity",
      "Answer yes only if BOTH: (1) `recorded_giving.last_gift_date` is within 365 days before `as_of_date`, AND (2) `recorded_giving.lifetime_total` is at least 1000. Amounts are recorded-giving evidence only, not wealth verification.",
      "Yes: both conditions hold.",
      "No: either condition fails.",
      (s) => (BASE.gaveWithin(s, 365) && BASE.lifetimeAtLeast(s, 1000) ? true : false),
    ),
  );
  out.push(
    noul(
      "lapsed_giver_1y_plus",
      "Answer yes only if BOTH: (1) a `recorded_giving.last_gift_date` is listed more than 365 days before `as_of_date`, AND (2) `recorded_giving.lifetime_total` is at least 1000.",
      "Yes: previously gave beyond 365 days and lifetime_total >= 1000.",
      "No: either condition fails, or no last_gift_date is listed.",
      (s) => (BASE.lapsedOver(s, 365) && BASE.lifetimeAtLeast(s, 1000) ? true : false),
    ),
  );
  out.push(
    noul(
      "lapsed_but_engaged",
      "Answer yes only if BOTH: (1) the last `recorded_giving.last_gift_date` is more than 365 days before `as_of_date` (lapsed), AND (2) `engagement.events` lists at least one entry.",
      "Yes: lapsed giver with ongoing engagement evidence.",
      "No: either condition fails.",
      (s) => (BASE.lapsedOver(s, 365) && BASE.eventCount(s) >= 1 ? true : false),
    ),
  );
  out.push(
    noul(
      "never_giver_eligible",
      "Answer yes only if BOTH: (1) no recorded giving (`recorded_giving.lifetime_total` and `last_gift_date` absent), AND (2) `permissions.eligible_for_solicitation` reads true.",
      "Yes: no giving history and solicitation is permitted.",
      "No: either condition fails.",
      (s) => (BASE.neverGave(s) && s.permissions.eligible_for_solicitation ? true : false),
    ),
  );
  out.push(
    noul(
      "recent_giver_major",
      "Answer yes only if BOTH: (1) `recorded_giving.last_gift_date` is within 365 days before `as_of_date`, AND (2) `recorded_giving.lifetime_total` is at least 10000. Amounts are recorded-giving evidence, not wealth or capacity verification.",
      "Yes: both conditions hold.",
      "No: either condition fails.",
      (s) => (BASE.gaveWithin(s, 365) && BASE.lifetimeAtLeast(s, 10000) ? true : false),
    ),
  );
  out.push(
    noul(
      "major_donor_senior",
      "Answer yes only if BOTH: (1) `recorded_giving.lifetime_total` is at least 25000, AND (2) `context.title` contains 'chief', 'president', or 'founder' (case-insensitive). Amounts are recorded-giving evidence only; title does NOT indicate capacity.",
      "Yes: both conditions hold.",
      "No: either condition fails.",
      (s) => (BASE.lifetimeAtLeast(s, 25000) && (titleIs(s, ["chief", "president", "founder"]) ?? false) ? true : false),
    ),
  );
  out.push(
    noul(
      "engaged_giver_500plus",
      "Answer yes only if BOTH: (1) `recorded_giving.last_gift_amount` is at least 500, AND (2) `engagement.events` lists at least one entry.",
      "Yes: both conditions hold.",
      "No: either condition fails.",
      (s) => (BASE.lastAmountAtLeast(s, 500) && BASE.eventCount(s) >= 1 ? true : false),
    ),
  );

  // S. More title keywords (6)
  for (const kw of ["board", "owner", "principal", "executive", "evp", "svp"]) {
    out.push(
      noul(
        `title_has_${kw}`,
        "Does `context.title` (case-insensitive, substring) contain " +
          `'${kw}'` +
          "? Answer from the listed title only; a missing title is not a yes.",
        `Yes: the listed title contains '${kw}'.`,
        `No: no title is listed, or it does not contain '${kw}'.`,
        (s) => titleIs(s, [kw]) ?? false,
      ),
    );
  }

  // T. Last gift in current calendar year (1)
  out.push(
    noul(
      "last_gift_this_calendar_year",
      "Does `recorded_giving.last_gift_date` fall in the same calendar year as `as_of_date`? Compare year digits only.",
      "Yes: last_gift_date year equals as_of_date year.",
      "No: no last_gift_date, or an earlier year.",
      (s) => {
        const d = s.recorded_giving.last_gift_date;
        return d != null && d.slice(0, 4) === s.as_of_date.slice(0, 4);
      },
    ),
  );

  // U. High-frequency 24-month counts (2)
  for (const k of [9, 10]) {
    out.push(
      noul(
        `gifts_24mo_at_least_${k}`,
        "Does `recorded_giving.gift_count_24mo` list at least " + `${k} gifts?`,
        `Yes: gift_count_24mo >= ${k}.`,
        `No: gift_count_24mo is missing or < ${k}.`,
        (s) => BASE.giftsAtLeast(s, k),
      ),
    );
  }

  return out;
}

let characteristicById: Map<string, CharacteristicQuestion> | null = null;

function characteristicIndex(): Map<string, CharacteristicQuestion> {
  characteristicById ??= new Map(buildCharacteristicQuestions().map((q) => [q.id, q]));
  return characteristicById;
}

/** Code mirror entrypoint: deterministic ground truth for one characteristic id. */
export function evaluateCharacteristic(state: JevState, id: string): boolean | null {
  return characteristicIndex().get(id)?.codeCheck(state) ?? null;
}