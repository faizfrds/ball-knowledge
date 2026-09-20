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
