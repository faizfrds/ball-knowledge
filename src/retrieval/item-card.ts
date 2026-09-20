import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { DATASET_VERSION } from "../config.js";
import { assertAsOf } from "../data-access.js";
import { EVIDENCE_VERSION, stableStringify } from "../givecampus/criterion.js";
import {
  getAttendanceAsOf,
  getCareerAsOf,
  getInteractionsAsOf,
  getPaidGiftsAsOf,
} from "../givecampus/store.js";
import type { FieldName } from "../pipeline/rubric.js";

export interface ConstituentCardFields {
  gift_recency_band?: string;
  gift_frequency_band?: string;
  giving_amount_band?: string;
  engagement_events?: string[];
  interaction_summary?: string[];
  career_change_band?: string;
  title?: string;
  employer?: string;
  city?: string;
  state?: string;
  affiliation_type?: string[];
  class_year?: number;
  contactability?: string;
  solicitation_fatigue_band?: string;
}

export interface ConstituentCard {
  constituentId: number;
  asOf: string;
  searchText: string;
  fields: ConstituentCardFields;
  evidenceRefs: Partial<Record<FieldName, string[]>>;
  hash: string;
}

function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000));
}

function countBand(count: number): string {
  if (count === 0) return "none";
  if (count === 1) return "1";
  if (count <= 4) return "2-4";
  return "5+";
}

function recencyBand(days: number | null): string {
  if (days === null) return "never";
  if (days <= 30) return "within 30 days";
  if (days <= 90) return "31-90 days";
  if (days <= 365) return "91-365 days";
  if (days <= 730) return "1-2 years";
  if (days <= 1825) return "2-5 years";
  return "over 5 years";
}

function amountBand(total: number): string {
  if (total <= 0) return "none recorded";
  if (total < 500) return "under $500";
  if (total < 5000) return "$500-$5k";
  if (total < 25000) return "$5k-$25k";
  return "$25k or more";
}

function hashCard(input: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(input), "utf8").digest("hex");
}

/** Build one as-of-safe card. It never reads names, contact values, or raw notes. */
export function buildConstituentCard(args: {
  db: Database.Database;
  constituentId: number;
  asOf: string;
  datasetVersion?: string;
  evidenceVersion?: string;
}): ConstituentCard {
  const { db, constituentId, asOf } = args;
  assertAsOf(asOf);
  const constituent = db.prepare(`SELECT id, email_status, phone_status, city, state, record_updated_at
    FROM constituents WHERE id = ?`).get(constituentId) as {
    id: number; email_status: string; phone_status: string; city: string | null; state: string | null;
    record_updated_at: string;
  } | undefined;
  if (!constituent) throw new Error(`Constituent not found: ${constituentId}`);
  const asOfYear = Number(asOf.slice(0, 4));
  const constituentSnapshotAvailable = constituent.record_updated_at.slice(0, 10) <= asOf;
  const affiliations = db.prepare(`SELECT id, affiliation_type FROM affiliations
    WHERE constituent_id = ? AND (start_year IS NULL OR start_year <= ?)
      AND (end_year IS NULL OR end_year >= ?) ORDER BY id`).all(constituentId, asOfYear, asOfYear) as {
    id: number; affiliation_type: string;
  }[];
  const degrees = db.prepare(`SELECT id, class_year FROM degrees WHERE constituent_id = ?
    AND class_year IS NOT NULL ORDER BY class_year, id`).all(constituentId) as {
    id: number; class_year: number;
  }[];
  const activities = db.prepare(`SELECT id, activity_type, activity_name FROM activities
    WHERE constituent_id = ? AND (start_year IS NULL OR start_year <= ?)
      AND (end_year IS NULL OR end_year >= ?) ORDER BY id`).all(constituentId, asOfYear, asOfYear) as {
    id: number; activity_type: string; activity_name: string;
  }[];

  const gifts = getPaidGiftsAsOf(db, constituentId, asOf).filter(
    (gift) => gift.status === "paid" && gift.gift_type !== "recurring_parent",
  );
  const fiveYearsAgo = `${String(asOfYear - 5).padStart(4, "0")}${asOf.slice(4)}`;
  const fiveYearGifts = gifts.filter((gift) => gift.gift_date.slice(0, 10) > fiveYearsAgo);
  const lastGift = gifts.at(-1);
  const interactions = getInteractionsAsOf(db, constituentId, asOf);
  const attendance = getAttendanceAsOf(db, constituentId, asOf);
  const career = getCareerAsOf(db, constituentId, asOf);
  const currentCareer = career.filter((row) => row.is_current === 1).at(-1);
  const latestCareer = career.at(-1);

  const attendanceDetails = attendance.map((row) => {
    const event = db.prepare(`SELECT event_type, name FROM events WHERE id = ?`).get(row.event_id) as {
      event_type: string | null; name: string | null;
    } | undefined;
    return { row, label: event?.name || event?.event_type || "attended event" };
  });
  const fields: ConstituentCardFields = {
    gift_recency_band: recencyBand(lastGift ? daysBetween(lastGift.gift_date.slice(0, 10), asOf) : null),
    gift_frequency_band: countBand(fiveYearGifts.length),
    giving_amount_band: amountBand(fiveYearGifts.reduce((sum, gift) => sum + gift.amount, 0)),
    ...(constituentSnapshotAvailable ? { contactability: constituent.email_status === "deliverable" && constituent.phone_status === "available"
      ? "email and phone"
      : constituent.email_status === "deliverable"
        ? "email"
        : constituent.phone_status === "available" ? "phone" : "none recorded" } : {}),
    solicitation_fatigue_band: "no solicitation recorded",
  };
  const evidenceRefs: Partial<Record<FieldName, string[]>> = {};
  const setRefs = (field: FieldName, refs: string[]) => { evidenceRefs[field] = [...new Set(refs)]; };
  setRefs("gift_recency_band", gifts.map((gift) => `gifts:${gift.id}`));
  setRefs("gift_frequency_band", fiveYearGifts.map((gift) => `gifts:${gift.id}`));
  setRefs("giving_amount_band", fiveYearGifts.map((gift) => `gifts:${gift.id}`));
  if (constituentSnapshotAvailable) setRefs("contactability", [`constituents:${constituentId}`]);
  setRefs("solicitation_fatigue_band", interactions.map((row) => `interactions:${row.id}`));

  const twoYearsAgo = `${String(asOfYear - 2).padStart(4, "0")}${asOf.slice(4)}`;
  const recentAttendance = attendanceDetails.filter((detail) => detail.row.attended_at.slice(0, 10) > twoYearsAgo);
  const eventValues = [
    ...recentAttendance.map((detail) => detail.label),
    ...activities.map((activity) => activity.activity_name || activity.activity_type).filter(Boolean),
  ];
  if (eventValues.length > 0) fields.engagement_events = [...new Set(eventValues)].slice(0, 12);
  setRefs("engagement_events", [
    ...recentAttendance.map((detail) => `event_attendance:${detail.row.id}`),
    ...activities.map((activity) => `activities:${activity.id}`),
  ]);

  const recentInteractions = interactions.slice(-8);
  if (recentInteractions.length > 0) {
    fields.interaction_summary = recentInteractions.map((row) => `${row.purpose}:${row.outcome}`);
  }
  setRefs("interaction_summary", recentInteractions.map((row) => `interactions:${row.id}`));

  const solicitationInteractions = interactions.filter((row) => /solicit|ask|fundrais/i.test(row.purpose));
  const since90Days = new Date(Date.parse(`${asOf}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
  const recentSolicitations = solicitationInteractions.filter((row) => row.occurred_at.slice(0, 10) > since90Days);
  fields.solicitation_fatigue_band = recentSolicitations.length === 0
    ? (solicitationInteractions.length === 0 ? "no solicitation recorded" : "none in 90 days")
    : recentSolicitations.length === 1 ? "1 in 90 days" : "2+ in 90 days";
  setRefs("solicitation_fatigue_band", solicitationInteractions.map((row) => `interactions:${row.id}`));

  if (latestCareer) {
    const careerDays = daysBetween(latestCareer.recorded_at.slice(0, 10), asOf);
    fields.career_change_band = careerDays <= 90 ? "recorded within 90 days"
      : careerDays <= 180 ? "recorded 91-180 days ago"
        : careerDays <= 365 ? "recorded 181-365 days ago" : "recorded over a year ago";
    setRefs("career_change_band", career.map((row) => `career_history:${row.id}`));
  }
  if (currentCareer?.job_title) {
    fields.title = currentCareer.job_title;
    setRefs("title", [`career_history:${currentCareer.id}`]);
  }
  if (currentCareer?.employer) {
    fields.employer = currentCareer.employer;
    setRefs("employer", [`career_history:${currentCareer.id}`]);
  }
  if (constituentSnapshotAvailable && constituent.city) fields.city = constituent.city;
  if (constituentSnapshotAvailable && constituent.state) fields.state = constituent.state;
  if (constituentSnapshotAvailable) {
    setRefs("city", [`constituents:${constituentId}`]);
    setRefs("state", [`constituents:${constituentId}`]);
  }
  if (affiliations.length > 0) fields.affiliation_type = affiliations.map((row) => row.affiliation_type);
  setRefs("affiliation_type", affiliations.map((row) => `affiliations:${row.id}`));
  if (degrees.length > 0) {
    const degree = degrees[0]!;
    fields.class_year = degree.class_year;
    setRefs("class_year", [ `degrees:${degree.id}` ]);
  }

  const searchText = Object.entries(fields)
    .flatMap(([field, value]) => Array.isArray(value) ? value.map((part) => `${field.replaceAll("_", " ")}: ${part}`) : [`${field.replaceAll("_", " ")}: ${value}`])
    .join(". ");
  const hash = hashCard({
    datasetVersion: args.datasetVersion ?? DATASET_VERSION,
    evidenceVersion: args.evidenceVersion ?? EVIDENCE_VERSION,
    asOf,
    constituentId,
    fields,
  });
  return { constituentId, asOf, searchText, fields, evidenceRefs, hash };
}

/** Strict per-question projection. Retrieval scores, IDs, evidence, and card text never enter Jev state. */
export function formatQuestionState(card: ConstituentCard, requiredFields: readonly FieldName[]): Partial<ConstituentCardFields> {
  const projected: Record<string, string | string[] | number> = {};
  for (const field of [...new Set(requiredFields)]) {
    const value = card.fields[field];
    if (value !== undefined) projected[field] = Array.isArray(value) ? [...value] : value;
  }
  return projected as Partial<ConstituentCardFields>;
}
