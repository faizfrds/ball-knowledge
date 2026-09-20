import { describe, expect, it } from "vitest";
import {
  buildConstituentFeatures,
  summarizeGifts,
  summarizeInteractions,
} from "../src/features.js";

const AS_OF = "2026-08-31";

describe("summarizeGifts", () => {
  it("excludes recurring_parent commitment headers from received cash", () => {
    const s = summarizeGifts(
      [
        { id: 1, gift_date: "2024-01-15", amount: 1200, status: "paid", gift_type: "recurring_parent" },
        { id: 2, gift_date: "2024-02-01", amount: 100, status: "paid", gift_type: "installment" },
        { id: 3, gift_date: "2024-03-01", amount: 100, status: "paid", gift_type: "installment" },
      ],
      AS_OF,
    );
    expect(s.totalPaid).toBe(200);
    expect(s.paidCount).toBe(2);
    expect(s.evidenceGiftIds).toEqual([2, 3]);
  });

  it("ignores records after as-of (leakage guard) and non-cash statuses", () => {
    const s = summarizeGifts(
      [
        { id: 1, gift_date: "2026-08-30", amount: 50, status: "paid", gift_type: "one_time" },
        { id: 2, gift_date: "2026-09-01", amount: 9999, status: "paid", gift_type: "one_time" },
        { id: 3, gift_date: "2026-08-01", amount: 500, status: "pledged", gift_type: "pledge" },
        { id: 4, gift_date: "2026-08-01", amount: 10, status: "failed", gift_type: "one_time" },
      ],
      AS_OF,
    );
    expect(s.totalPaid).toBe(50);
    expect(s.lastPaidDate).toBe("2026-08-30");
    expect(s.daysSinceLastPaid).toBe(1);
    expect(s.pledgedOutstanding).toBe(500);
  });

  it("returns nulls for never-donors", () => {
    const s = summarizeGifts([], AS_OF);
    expect(s.totalPaid).toBe(0);
    expect(s.lastPaidDate).toBeNull();
    expect(s.daysSinceLastPaid).toBeNull();
  });
});

describe("summarizeInteractions", () => {
  it("cuts off future interactions and counts overdue follow-ups as-of", () => {
    const s = summarizeInteractions(
      [
        { id: 1, occurred_at: "2026-08-01T10:00:00Z", follow_up_date: "2026-08-10" },
        { id: 2, occurred_at: "2026-09-05T10:00:00Z", follow_up_date: "2026-09-06" },
      ],
      AS_OF,
    );
    expect(s.totalCount).toBe(1);
    expect(s.overdueFollowUps).toBe(1);
    expect(s.evidenceInteractionIds).toEqual([1]);
  });
});

describe("buildConstituentFeatures", () => {
  it("flags deceased / do_not_solicit as excluded with evidence", () => {
    const f = buildConstituentFeatures({
      constituent: { id: 7, deceased: 1, do_not_solicit: 0 },
      gifts: [{ id: 9, gift_date: "2020-01-01", amount: 25, status: "paid", gift_type: "one_time" }],
      interactions: [],
      attendance: [{ id: 3, attended_at: "2025-01-01T00:00:00Z" }],
      asOf: AS_OF,
    });
    expect(f.excluded).toBe(true);
    expect(f.exclusionReason).toBe("deceased");
    expect(f.evidence).toContainEqual({ table: "constituents", id: 7 });
    expect(f.evidence).toContainEqual({ table: "gifts", id: 9 });
    expect(f.eventAttendanceCount).toBe(1);
  });

  it("is deterministic for the same inputs", () => {
    const args = {
      constituent: { id: 1, deceased: 0, do_not_solicit: 0 },
      gifts: [{ id: 1, gift_date: "2024-05-05", amount: 100, status: "paid", gift_type: "one_time" as const }],
      interactions: [{ id: 1, occurred_at: "2024-06-01T00:00:00Z" }],
      attendance: [],
      asOf: AS_OF,
    };
    expect(buildConstituentFeatures(args)).toEqual(buildConstituentFeatures(args));
  });
});
