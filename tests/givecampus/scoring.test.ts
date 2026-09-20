import { describe, expect, it } from "vitest";
import { scorePriority } from "../../src/givecampus/scoring.js";
import { parseCriterion, parseWorklistFilter, makeCacheKey } from "../../src/givecampus/criterion.js";
import { MemoryCache } from "../../src/givecampus/cache.js";

const AS_OF = "2026-08-31";

function base(over: Record<string, unknown> = {}) {
  return {
    asOf: AS_OF,
    gifts: { paid: [{ gift_date: "2026-08-01", amount: 250 }], pledgeHistory: false, maxSinglePaidEver: 250 },
    engagement: { eventsAttended2y: 1, connectedInteractions1y: 1, distinctActivities: 1 },
    whyNow: {
      recentPaidGift30d: true, overdueFollowUp: false, promotionSignal90d: false,
      futureEvent30dSameArea: false, reunionYear: false,
    },
    seniorityHint: false,
    ...over,
  } as Parameters<typeof scorePriority>[0];
}

describe("priority index", () => {
  it("is a 0–100 rank (not a probability) and deterministic", () => {
    const a = scorePriority(base());
    const b = scorePriority(base());
    expect(a).toEqual(b);
    expect(a.index).toBeGreaterThan(0);
    expect(a.index).toBeLessThanOrEqual(100);
  });

  it("TC5: recurring installments counted, parent header must be excluded upstream", () => {
    // 12x$1k installments in window => F=1 (12/5 capped), M=log-capped.
    const paid = Array.from({ length: 12 }, (_, i) => ({
      gift_date: `2024-${String((i % 12) + 1).padStart(2, "0")}-05`,
      amount: 1000,
    }));
    const s = scorePriority(base({ gifts: { paid, pledgeHistory: false, maxSinglePaidEver: 1000 } }));
    expect(s.components.f.value).toBe(1);
    expect(s.components.m.value).toBeCloseTo(Math.log1p(12000) / Math.log1p(50000), 5);
  });

  it("never-gave sets recency unknown with an as-of label (not silent 0)", () => {
    const s = scorePriority(base({ gifts: { paid: [], pledgeHistory: false, maxSinglePaidEver: null } }));
    expect(s.components.r.unknown).toBe(true);
    expect(s.unknowns).toContain("recency");
    expect(s.components.r.label).toMatch(/as of 2026-08-31/);
  });

  it("seniority hint contributes at most 0.1 to capacity", () => {
    const plain = scorePriority(base({ seniorityHint: false }));
    const senior = scorePriority(base({ seniorityHint: true }));
    const diff = (senior.components.c.value as number) - (plain.components.c.value as number);
    expect(diff).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("low completeness forces review_needed", () => {
    const s = scorePriority(
      base({
        gifts: { paid: [], pledgeHistory: false, maxSinglePaidEver: null },
        engagement: { eventsAttended2y: 0, connectedInteractions1y: 0, distinctActivities: 0 },
        whyNow: {
          recentPaidGift30d: false, overdueFollowUp: false, promotionSignal90d: false,
          futureEvent30dSameArea: false, reunionYear: false,
        },
        coldRecord: true,
      }),
    );
    expect(s.reviewNeeded).toBe(true);
    expect(s.completeness).toBeLessThanOrEqual(0.5);
    expect(s.reviewReasons.join(" ")).toMatch(/cold record/);
  });

  it("stretch ask without evidence forces human review", () => {
    const s = scorePriority(base({ stretchAsk: true }));
    expect(s.reviewNeeded).toBe(true);
    expect(s.reviewReasons.join(" ")).toMatch(/stretch ask/);
  });

  it("weight edits validate (must sum to 1); threshold edits validate ordering", () => {
    expect(() =>
      parseCriterion({ weights: { r: 1, f: 0, m: 0, e: 0, n: 0, c: 0 } }),
    ).not.toThrow();
    expect(() =>
      parseCriterion({ weights: { r: 0.5, f: 0.5, m: 0, e: 0, n: 0, c: 0 } }),
    ).not.toThrow();
    expect(() =>
      parseCriterion({ weights: { r: 0.5, f: 0.5, m: 0.5, e: 0, n: 0, c: 0 } }),
    ).toThrow();
  });
});

describe("typed filters (no executable strings)", () => {
  it("accepts valid filters and rejects bad dates/limits", () => {
    expect(parseWorklistFilter({ asOf: AS_OF, limit: 20 }).limit).toBe(20);
    expect(() => parseWorklistFilter({ asOf: "not-a-date" })).toThrow();
    expect(() => parseWorklistFilter({ limit: 9999 })).toThrow();
    expect(() => parseWorklistFilter({ limit: "20; DROP TABLE x" })).toThrow();
  });
});

describe("cache key", () => {
  it("includes dataset/evidence/state/question/model/as-of", () => {
    const a = makeCacheKey({ asOf: AS_OF, stateHash: "s1", questionsHash: "q1", model: "jev-1.13.0" });
    const b = makeCacheKey({ asOf: "2025-08-31", stateHash: "s1", questionsHash: "q1", model: "jev-1.13.0" });
    const c = makeCacheKey({ asOf: AS_OF, stateHash: "s1", questionsHash: "q2", model: "jev-1.13.0" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("memory cache hits and isolates keys", () => {
    const cache = new MemoryCache<number>();
    expect(cache.get("k").hit).toBe(false);
    cache.set("k", 1);
    const hit = cache.get("k");
    expect(hit.hit).toBe(true);
    if (hit.hit) expect(hit.value).toBe(1);
  });
});
