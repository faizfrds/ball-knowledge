import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..");

/** Dataset contract — see reference DATASET_README.md. Never derive features past this date. */
export const AS_OF_DATE = "2026-08-31";
export const DATASET_VERSION = "1.2";
export const INSTITUTION = "GiveCampus University";

/** Reference package dir (read-only — never write here). */
export const REFERENCE_DIR = path.join(
  REPO_ROOT,
  "20260919_GiveCampus_MIT_Hackathon-20260920T063012Z-1-001",
  "20260919_GiveCampus_MIT_Hackathon",
);

export function resolveDataDir(override?: string): string {
  return (
    override ??
    process.env.GIVE_CAMPUS_DATA_DIR ??
    path.join(REFERENCE_DIR, "data")
  );
}

export function resolveSchemaPath(override?: string): string {
  return (
    override ??
    process.env.GIVE_CAMPUS_SCHEMA ??
    path.join(REFERENCE_DIR, "schema.sql")
  );
}

export function resolveDbPath(override?: string): string {
  return (
    override ??
    process.env.GIVE_CAMPUS_DB ??
    path.join(REPO_ROOT, "data", "givecampus.sqlite")
  );
}

/** Ingest order respects FK dependencies (mirrors reference load_sqlite.py). */
export const INGEST_TABLES = [
  "schools",
  "staff",
  "constituents",
  "affiliations",
  "degrees",
  "activities",
  "funds",
  "campaigns",
  "opportunities",
  "gifts",
  "gift_allocations",
  "interactions",
  "events",
  "event_attendance",
  "career_history",
] as const;

export type IngestTable = (typeof INGEST_TABLES)[number];

/** Expected CSV headers per table (captured from the v1.2 reference package).
 * Ingest fails closed on any mismatch (schema drift) instead of silently
 * dropping extra cells or padding short rows. */
export const EXPECTED_CSV_HEADERS: Record<IngestTable, readonly string[]> = {
  schools: ["id", "name", "school_type", "fiscal_year_start_month", "timezone", "currency"],
  staff: ["id", "school_id", "display_name", "role", "region", "portfolio_capacity", "active"],
  constituents: [
    "id", "school_id", "entity_type", "preferred_name", "first_name", "last_name",
    "primary_email", "email_status", "phone_status", "city", "state", "country",
    "latitude", "longitude", "assigned_staff_id", "do_not_solicit", "deceased",
    "deceased_date", "record_source", "record_created_at", "record_updated_at",
  ],
  affiliations: [
    "id", "school_id", "constituent_id", "affiliation_type", "raw_affiliation_value",
    "start_year", "end_year", "is_primary", "record_source",
  ],
  degrees: [
    "id", "school_id", "constituent_id", "degree_type", "school_or_unit",
    "major", "class_year", "start_year", "record_source",
  ],
  activities: [
    "id", "school_id", "constituent_id", "activity_type", "activity_name",
    "role", "start_year", "end_year", "record_source",
  ],
  funds: ["id", "school_id", "name", "fund_code", "category", "active"],
  campaigns: [
    "id", "school_id", "name", "campaign_type", "audience_description", "goal_type",
    "goal_amount", "goal_donor_count", "starts_at", "ends_at", "status",
    "default_fund_id", "is_recurring_enabled", "is_match_or_challenge_active",
  ],
  opportunities: [
    "id", "school_id", "constituent_id", "staff_id", "campaign_id", "fund_id",
    "status", "expected_ask_amount", "ask_amount", "accepted_amount",
    "expected_ask_date", "ask_date", "response_date", "closed_at", "close_reason",
    "likelihood_band", "notes",
  ],
  gifts: [
    "id", "school_id", "constituent_id", "campaign_id", "opportunity_id", "gift_date",
    "amount", "currency", "status", "gift_type", "gift_channel", "record_source",
    "payment_method", "anonymous", "fiscal_year", "external_id", "linked_parent_gift_id",
  ],
  gift_allocations: ["id", "school_id", "gift_id", "fund_id", "amount", "raw_fund_name"],
  interactions: [
    "id", "school_id", "constituent_id", "staff_id", "occurred_at", "interaction_type",
    "direction", "purpose", "outcome", "ask_amount", "significant", "subject", "notes",
    "follow_up_date", "related_opportunity_id", "related_campaign_id", "related_gift_id",
    "record_source",
  ],
  events: [
    "id", "school_id", "name", "event_type", "starts_at", "ends_at", "city", "state",
    "latitude", "longitude", "audience_description", "capacity", "related_campaign_id",
  ],
  event_attendance: ["id", "school_id", "event_id", "constituent_id", "attended_at", "record_source"],
  career_history: [
    "id", "school_id", "constituent_id", "employer", "job_title", "industry",
    "started_at", "ended_at", "is_current", "recorded_at", "record_source",
  ],
};

/** Numeric (NUMERIC) columns per table: must be finite numbers when non-empty.
 * normalizeValue throws on non-finite input so bad CSV can never silently
 * propagate NaN into feature math. Money stays NUMERIC in SQLite; sum via
 * integer cents (see normalize toCents) to avoid binary-float drift. */
export const NUMERIC_COLUMNS: Record<string, Set<string>> = {
  campaigns: new Set(["goal_amount", "goal_donor_count"]),
  opportunities: new Set(["expected_ask_amount", "ask_amount", "accepted_amount"]),
  gifts: new Set(["amount"]),
  gift_allocations: new Set(["amount"]),
  interactions: new Set(["ask_amount"]),
};

/** True when `child` resolves inside `parent` (both already resolved). */
export function isPathInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
/** Boolean columns per table: CSV "true"/"false" -> 1/0, empty -> NULL. */
export const BOOLEAN_COLUMNS: Record<string, Set<string>> = {
  staff: new Set(["active"]),
  constituents: new Set(["do_not_solicit", "deceased"]),
  affiliations: new Set(["is_primary"]),
  funds: new Set(["active"]),
  campaigns: new Set(["is_recurring_enabled", "is_match_or_challenge_active"]),
  gifts: new Set(["anonymous"]),
  interactions: new Set(["significant"]),
  career_history: new Set(["is_current"]),
};
