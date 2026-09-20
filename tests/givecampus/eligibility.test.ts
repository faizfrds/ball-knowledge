import { describe, expect, it } from "vitest";
import { checkEligibility } from "../../src/givecampus/eligibility.js";

const AS_OF = "2026-08-31";

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    entity_type: "individual",
    deceased: 0,
    deceased_date: null,
    do_not_solicit: 0,
    email_status: "deliverable",
    phone_status: "available",
    ...over,
  };
}

describe("eligibility gates", () => {
  it("TC1: deceased with historical giving is ineligible (E1), gifts stay visible elsewhere", () => {
    const r = checkEligibility({
      constituent: row({ deceased: 1, deceased_date: "2020-05-01" }),
      asOf: AS_OF,
    });
    expect(r.eligibleForContact).toBe(false);
    expect(r.gates.find((g) => g.gate === "E1.person_alive")?.pass).toBe(false);
  });

  it("deceased flag with future deceased_date is alive at T0 (historical semantics)", () => {
    const r = checkEligibility({
      constituent: row({ deceased: 1, deceased_date: "2027-01-01" }),
      asOf: AS_OF,
    });
    expect(r.gates.find((g) => g.gate === "E1.person_alive")?.pass).toBe(true);
    expect(r.eligibleForContact).toBe(true);
  });

  it("deceased flag without a date still excludes", () => {
    const r = checkEligibility({
      constituent: row({ deceased: 1, deceased_date: null }),
      asOf: AS_OF,
    });
    expect(r.eligibleForContact).toBe(false);
  });

  it("TC2: do_not_solicit fails E2 and excludes from contact ranks", () => {
    const r = checkEligibility({ constituent: row({ do_not_solicit: 1 }), asOf: AS_OF });
    expect(r.gates.find((g) => g.gate === "E2.not_suppressed")?.pass).toBe(false);
    expect(r.eligibleForContact).toBe(false);
  });

  it("TC3: unreachable (missing/missing) fails E3", () => {
    const r = checkEligibility({
      constituent: row({ email_status: "missing", phone_status: "missing" }),
      asOf: AS_OF,
    });
    expect(r.gates.find((g) => g.gate === "E3.reachable")?.pass).toBe(false);
    expect(r.eligibleForContact).toBe(false);
  });

  it("either channel suffices; channel flags are exposed", () => {
    const r = checkEligibility({
      constituent: row({ email_status: "do_not_email", phone_status: "available" }),
      asOf: AS_OF,
    });
    expect(r.eligibleForContact).toBe(true);
    expect(r.emailOk).toBe(false);
    expect(r.phoneOk).toBe(true);
  });

  it("TC6: current student stays contact-eligible but is solicit-restricted (action-level)", () => {
    const r = checkEligibility({
      constituent: row(),
      affiliations: [{ affiliation_type: "student" }],
      degrees: [{ class_year: 2027, degree_type: "B.A." }],
      asOf: AS_OF,
    });
    expect(r.isCurrentStudent).toBe(true);
    expect(r.eligibleForContact).toBe(true);
    expect(r.eligibleForSolicit).toBe(false);
  });

  it("alumni with past class_year is not a student", () => {
    const r = checkEligibility({
      constituent: row(),
      affiliations: [{ affiliation_type: "alumni" }],
      degrees: [{ class_year: 2010, degree_type: "B.A." }],
      asOf: AS_OF,
    });
    expect(r.isCurrentStudent).toBe(false);
    expect(r.eligibleForSolicit).toBe(true);
  });

  it("organizations are excluded from the person worklist (E5)", () => {
    const r = checkEligibility({ constituent: row({ entity_type: "organization" }), asOf: AS_OF });
    expect(r.eligibleForContact).toBe(false);
  });

  it("TC7: missing affiliation is retained (E6 informational, not a drop)", () => {
    const r = checkEligibility({ constituent: row(), affiliations: [], asOf: AS_OF });
    expect(r.affiliationMissing).toBe(true);
    expect(r.eligibleForContact).toBe(true);
  });
});
