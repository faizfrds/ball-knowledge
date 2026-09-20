import { describe, expect, it } from "vitest";
import {
  HEADLINE_QUESTIONS,
  JEV_MODEL,
  MockJevClient,
  evaluateWithJev,
  minus12mo,
  questionsHash,
  type JevState,
} from "../../src/givecampus/jev.js";
import { MemoryCache } from "../../src/givecampus/cache.js";
import type { JevCallResult } from "../../src/givecampus/jev.js";

function state(over: Partial<JevState> = {}): JevState {
  return {
    constituent_id: "1",
    dataset_version: "1.2",
    evidence_version: "ev-001",
    as_of_date: "2026-08-31",
    as_of_date_minus_12mo: minus12mo("2026-08-31"),
    permissions: { do_not_contact: false, do_not_solicit: false, eligible_for_solicitation: true },
    recorded_giving: { last_gift_date: "2026-08-01", last_gift_amount: 250, lifetime_total: 350, gift_count_24mo: 2 },
    engagement: { events: ["attended 2025 alumni panel"] },
    explicit_capacity: { rating: null, source: null },
    context: { title: "Program Manager", employer: "Acme Corp" },
    ...over,
  };
}

describe("Jev contract", () => {
  it("model is pinned to jev-1.13.0 with the 6 headline questions", () => {
    expect(JEV_MODEL).toBe("jev-1.13.0");
    expect(Object.keys(HEADLINE_QUESTIONS).sort()).toEqual(
      [
        "capacity_evidence_strength", "engagement_level", "has_recent_gift",
        "has_repeat_giving", "permitted_action", "title_employer_context_present",
      ].sort(),
    );
    expect(questionsHash()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("missing key falls back safely (no throw, available=false)", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const out = await evaluateWithJev(state(), { eligibleForSolicitation: true });
      expect(out.available).toBe(false);
      expect(out.reason).toBe("missing_key");
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it("mock client evaluates without a key; cache serves warm hits", async () => {
    const cache = new MemoryCache<JevCallResult>();
    const client = new MockJevClient("personal_outreach");
    const first = await evaluateWithJev(state(), {
      client, cache, eligibleForSolicitation: true,
    });
    expect(first.available).toBe(true);
    expect(first.result?.cacheHit).toBe(false);
    expect(client.calls).toBe(1);
    const second = await evaluateWithJev(state(), {
      client, cache, eligibleForSolicitation: true,
    });
    expect(second.result?.cacheHit).toBe(true);
    expect(client.calls).toBe(1);
    expect(second.result?.usage.input_tokens).toBeGreaterThan(0);
  });

  it("code gate overrides a forbidden model action (gate_override + hold_for_review)", async () => {
    const client = new MockJevClient("personal_outreach");
    const out = await evaluateWithJev(
      state({ permissions: { do_not_contact: true, do_not_solicit: true, eligible_for_solicitation: false } }),
      { client, eligibleForSolicitation: false },
    );
    expect(out.available).toBe(true);
    expect(out.gateOverride).toBe(true);
    expect(out.finalAction).toBe("hold_for_review");
  });

  it("eligible constituents keep the model action", async () => {
    const client = new MockJevClient("stewardship_thank_you");
    const out = await evaluateWithJev(state(), { client, eligibleForSolicitation: true });
    expect(out.gateOverride).not.toBe(true);
    expect(out.finalAction).toBe("stewardship_thank_you");
  });
});
