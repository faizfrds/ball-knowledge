/**
 * Deterministic as-of-correct eligibility gates (E1–E6).
 *
 * Runs in code BEFORE any scoring or Jev call. No scores are computed
 * for ineligible rows.
 */

export interface ConstituentEligibilityRow {
  id: number;
  entity_type: string;
  deceased: number | boolean | null;
  deceased_date?: string | null;
  do_not_solicit: number | boolean | null;
  email_status: string;
  phone_status: string;
}

export interface AffiliationLite {
  affiliation_type: string;
}

export interface DegreeLite {
  class_year: number | null;
  degree_type: string | null;
}

export interface GateResult {
  gate: string;
  pass: boolean;
  evidence: string;
}

export interface EligibilityResult {
  constituentId: number;
  asOf: string;
  gates: GateResult[];
  eligibleForContact: boolean;
  eligibleForSolicit: boolean;
  isCurrentStudent: boolean;
  affiliationMissing: boolean;
  emailOk: boolean;
  phoneOk: boolean;
}

function toBool(v: number | boolean | null | undefined): boolean {
  return v === true || v === 1;
}

/** YYYY-MM-DD compare is chronological. Empty/undefined => false. */
function dateLe(a: string, b: string): boolean {
  return a.slice(0, 10) <= b.slice(0, 10);
}

export function isCurrentStudent(
  affiliations: AffiliationLite[],
  degrees: DegreeLite[],
  asOf: string,
): boolean {
  const asOfYear = Number(asOf.slice(0, 4));
  const hasStudentAffil = affiliations.some(
    (a) => a.affiliation_type?.toLowerCase() === "student",
  );
  if (!hasStudentAffil) return false;
  return degrees.some(
    (d) => typeof d.class_year === "number" && d.class_year > asOfYear,
  );
}

export function checkEligibility(args: {
  constituent: ConstituentEligibilityRow;
  affiliations?: AffiliationLite[];
  degrees?: DegreeLite[];
  asOf: string;
}): EligibilityResult {
  const { constituent: c, asOf } = args;
  const affiliations = args.affiliations ?? [];
  const degrees = args.degrees ?? [];
  const gates: GateResult[] = [];

  // E1: person alive — deceased_date is authoritative over the boolean.
  // Historical giving remains visible; only contact at/after death is barred.
  // Pass iff individual AND (no death date on/before T0) AND deceased flag
  // does not assert death on/before T0 without a date.
  const deathDate = c.deceased_date?.slice(0, 10) ?? null;
  const deadByDate = deathDate !== null && dateLe(deathDate, asOf);
  const flagDead = toBool(c.deceased);
  // Flag without a date means dead (dataset convention); flag with a future
  // date means still alive at T0 (historical-semantics case).
  const e1Alive =
    c.entity_type === "individual" &&
    !deadByDate &&
    (deathDate !== null ? true : !flagDead) &&
    !(flagDead && deathDate !== null && dateLe(deathDate, asOf));
  gates.push({
    gate: "E1.person_alive",
    pass: e1Alive,
    evidence: `constituents:${c.id} deceased=${flagDead} deceased_date=${deathDate ?? "null"} asOf=${asOf}`,
  });

  // E2: not suppressed (current snapshot row; file is the as-of snapshot).
  const e2 = !toBool(c.do_not_solicit);
  gates.push({
    gate: "E2.not_suppressed",
    pass: e2,
    evidence: `constituents:${c.id} do_not_solicit=${toBool(c.do_not_solicit)}`,
  });

  // E3: reachable via at least one permitted channel (status-only; no numbers stored).
  const emailOk = c.email_status === "deliverable";
  const phoneOk = c.phone_status === "available";
  const e3 = emailOk || phoneOk;
  gates.push({
    gate: "E3.reachable",
    pass: e3,
    evidence: `constituents:${c.id} email_status=${c.email_status} phone_status=${c.phone_status}`,
  });

  // E5: organization exclusion (person worklist only).
  const e5 = c.entity_type !== "organization";
  gates.push({
    gate: "E5.person_only",
    pass: e5,
    evidence: `constituents:${c.id} entity_type=${c.entity_type}`,
  });

  // E6 is structural (LEFT JOIN affiliations): never drops; surface the gap.
  const affiliationMissing = affiliations.length === 0;
  gates.push({
    gate: "E6.affiliation_present",
    pass: true,
    evidence: affiliationMissing
      ? `affiliations:none for constituent ${c.id} (intentional 500-row gap; retained via LEFT JOIN)`
      : `affiliations:${affiliations.length} rows for constituent ${c.id}`,
  });

  // E4: current-student solicitation restriction is action-level, not a drop.
  const student = isCurrentStudent(affiliations, degrees, asOf);
  gates.push({
    gate: "E4.not_current_student_for_solicitation",
    pass: !student,
    evidence: student
      ? `affiliations:student + future class_year vs ${asOf} — invite/cultivate only`
      : `no current-student signal as of ${asOf}`,
  });

  const eligibleForContact = e1Alive && e2 && e3 && e5;
  const eligibleForSolicit = eligibleForContact && !student;
  return {
    constituentId: c.id,
    asOf,
    gates,
    eligibleForContact,
    eligibleForSolicit,
    isCurrentStudent: student,
    affiliationMissing,
    emailOk,
    phoneOk,
  };
}
