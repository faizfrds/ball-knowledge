import { describe, expect, it } from "vitest";
import { decideActions, needsResearch } from "../../src/givecampus/actions.js";
import { checkEligibility } from "../../src/givecampus/eligibility.js";

const AS_OF = "2026-08-31";

function elig(over: Record<string, unknown> = {}) {
  return checkEligibility({
    constituent: {
      id: 1,
      entity_type: "individual",
      deceased: 0,
      deceased_date: null,
      do_not_solicit: 0,
      email_status: "deliverable",
      phone_status: "available",
      ...over,
    },
    asOf: AS_OF,
  });
}

describe("action permissions", () => {
  it("THANK is permitted for an unacknowledged recent paid gift", () => {
    const d = decideActions({
      eligibility: elig(),
      gifts: [{ id: 9, gift_date: "2026-08-01", amount: 250, status: "paid", gift_type: "one_time" }],
      interactions: [],
      asOf: AS_OF,
    });
    expect(d.permitted).toContain("thank");
    expect(d.action).toBe("thank");
  });

  it("THANK is blocked once an acknowledgement references the gift", () => {
    const d = decideActions({
      eligibility: elig(),
      gifts: [{ id: 9, gift_date: "2026-08-01", amount: 250, status: "paid", gift_type: "one_time" }],
      interactions: [
        {
          id: 1, occurred_at: "2026-08-10T10:00:00Z", purpose: "acknowledgement",
          outcome: "connected", direction: "outbound", follow_up_date: null, related_gift_id: 9,
        },
      ],
      asOf: AS_OF,
    });
    expect(d.permitted).not.toContain("thank");
  });

  it("TC4: channel split — email do_not_email + phone available => solicit via phone only", () => {
    const d = decideActions({
      eligibility: elig({ email_status: "do_not_email", phone_status: "available" }),
      gifts: [],
      interactions: [],
      asOf: AS_OF,
    });
    expect(d.permitted).toContain("solicit");
    expect(d.permittedChannel).toBe("phone");
  });

  it("solicitation fatigue (30d) denies solicit", () => {
    const d = decideActions({
      eligibility: elig(),
      gifts: [],
      interactions: [
        {
          id: 1, occurred_at: "2026-08-15T10:00:00Z", purpose: "solicitation",
          outcome: "connected", direction: "outbound", follow_up_date: null, related_gift_id: null,
        },
      ],
      asOf: AS_OF,
    });
    expect(d.permitted).not.toContain("solicit");
    expect(d.reasons.join(" ")).toMatch(/fatigue/);
  });

  it("open-ask collision (pledged + follow_up >= T0) denies solicit", () => {
    const d = decideActions({
      eligibility: elig(),
      gifts: [],
      interactions: [
        {
          id: 1, occurred_at: "2026-07-01T10:00:00Z", purpose: "solicitation",
          outcome: "pledged", direction: "outbound", follow_up_date: "2026-09-15", related_gift_id: null,
        },
      ],
      asOf: AS_OF,
    });
    expect(d.permitted).not.toContain("solicit");
  });

  it("student is solicit-denied but invite-permitted with a future event", () => {
    const e = checkEligibility({
      constituent: {
        id: 7, entity_type: "individual", deceased: 0, deceased_date: null,
        do_not_solicit: 0, email_status: "deliverable", phone_status: "available",
      },
      affiliations: [{ affiliation_type: "student" }],
      degrees: [{ class_year: 2027, degree_type: "B.A." }],
      asOf: AS_OF,
    });
    const d = decideActions({
      eligibility: e,
      gifts: [],
      interactions: [],
      futureEvents: [{ id: 1, starts_at: "2026-09-15T18:00:00Z" }],
      asOf: AS_OF,
    });
    expect(d.permitted).not.toContain("solicit");
    expect(d.permitted).toContain("invite");
    expect(d.action).toBe("invite");
  });

  it("tie-break prefers THANK over SOLICIT", () => {
    const d = decideActions({
      eligibility: elig(),
      gifts: [{ id: 9, gift_date: "2026-08-01", amount: 50, status: "paid", gift_type: "one_time" }],
      interactions: [],
      futureEvents: [{ id: 1, starts_at: "2026-09-15T18:00:00Z" }],
      asOf: AS_OF,
    });
    expect(d.action).toBe("thank");
    expect(d.permitted).toContain("solicit");
  });

  it("falls back to review_needed when nothing is permitted", () => {
    const d = decideActions({
      eligibility: elig(),
      gifts: [{ id: 9, gift_date: "2026-08-01", amount: 50, status: "paid", gift_type: "one_time" }],
      interactions: [
        {
          id: 1, occurred_at: "2026-08-20T10:00:00Z", purpose: "solicitation",
          outcome: "connected", direction: "outbound", follow_up_date: null, related_gift_id: null,
        },
        {
          id: 2, occurred_at: "2026-08-21T10:00:00Z", purpose: "acknowledgement",
          outcome: "connected", direction: "outbound", follow_up_date: null, related_gift_id: 9,
        },
      ],
      asOf: AS_OF,
    });
    expect(d.permitted).not.toContain("thank");
    expect(d.permitted).not.toContain("solicit");
    expect(d.permitted).not.toContain("cultivate");
    expect(d.action).toBe("review_needed");
  });
});

describe("needsResearch", () => {
  it("flags cold records and missing cities", () => {
    expect(needsResearch({ city: null, paidCount: 0, interactionCount: 0 }).needed).toBe(true);
    expect(needsResearch({ city: "Boston", paidCount: 2, interactionCount: 1 }).needed).toBe(false);
  });
});
