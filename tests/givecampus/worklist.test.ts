import { afterEach, describe, expect, it } from "vitest";
import { buildWorklist } from "../../src/givecampus/worklist.js";
import { clearJobs, createJob, getJob, runJob } from "../../src/givecampus/jobs.js";
import { getCareerAsOf } from "../../src/givecampus/store.js";
import { MockJevClient } from "../../src/givecampus/jev.js";
import { buildFixtureDbMemory } from "./fixture.js";

const AS_OF = "2026-08-31";

afterEach(() => clearJobs());

describe("worklist integration (fixture DB)", () => {
  it("ranks eligible constituents, excludes suppressed/deceased/unreachable, keeps affiliation-less", async () => {
    const db = buildFixtureDbMemory();
    try {
      const { entries, receipt, excluded } = await buildWorklist(
        db, { asOf: AS_OF, limit: 50, offset: 0 }, undefined, { scanLimit: 100 },
      );
      const ids = entries.map((e) => e.constituentId);
      // Excluded: 2 (deceased), 4 (suppressed), 5 (unreachable).
      expect(ids).not.toContain(2);
      expect(ids).not.toContain(4);
      expect(ids).not.toContain(5);
      expect(excluded).toBe(3);
      // Retained: healthy donor, future-deceased, phone-only, student (invite), no-affiliation, recurring, cold.
      for (const id of [1, 3, 6, 7, 8, 9, 10]) expect(ids).toContain(id);
      // Student is solicit-restricted.
      const student = entries.find((e) => e.constituentId === 7)!;
      expect(student.eligibleForSolicit).toBe(false);
      expect(student.action).toBe("invite");
      // Phone-only solicits via phone.
      const phone = entries.find((e) => e.constituentId === 6)!;
      expect(phone.permittedChannel).toBe("phone");
      // Receipt carries dataset/criterion/model/as-of identity + timing.
      expect(receipt.datasetVersion).toBe("1.2");
      expect(receipt.asOf).toBe(AS_OF);
      expect(receipt.model).toBe("jev-1.13.0");
      expect(receipt.criterionHash).toMatch(/^[0-9a-f]{16}$/);
      expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
      // Evidence refs + missing-data panel are populated.
      const healthy = entries.find((e) => e.constituentId === 1)!;
      expect(healthy.evidenceRefs).toContain("constituents:1");
      expect(healthy.evidenceRefs).toContain("gifts:2");
      expect(healthy.priorityIndex).not.toBeNull();
      const cold = entries.find((e) => e.constituentId === 10)!;
      expect(cold.missing.length).toBeGreaterThan(0);
      // Labels are rank-only: no probability/revenue claims in payload keys.
      expect(JSON.stringify(entries)).not.toMatch(/probability|expected_revenue|propensity/i);
    } finally {
      db.close();
    }
  });

  it("TC8: career leakage — recorded_at after T0 is invisible to the backtest", () => {
    const db = buildFixtureDbMemory();
    try {
      const before = getCareerAsOf(db, 1, "2025-08-31");
      const after = getCareerAsOf(db, 1, "2025-10-01");
      expect(before.map((c) => c.job_title)).toEqual(["Program Manager"]);
      expect(after.map((c) => c.job_title)).toEqual(["Program Manager", "Vice President"]);
    } finally {
      db.close();
    }
  });

  it("recurring trap: installment basis in the ranked output", async () => {
    const db = buildFixtureDbMemory();
    try {
      const { entries } = await buildWorklist(db, { asOf: AS_OF, limit: 50, offset: 0 }, undefined, { scanLimit: 100 });
      const rita = entries.find((e) => e.constituentId === 9)!;
      // 12 installments => frequency capped at 1; parent header excluded.
      expect(rita.priorityIndex).not.toBeNull();
      expect(rita.reviewNeeded).toBe(false);
    } finally {
      db.close();
    }
  });

  it("Jev enrichment via mock client records usage + cache hits", async () => {
    const db = buildFixtureDbMemory();
    try {
      const client = new MockJevClient("personal_outreach");
      const first = await buildWorklist(db, { asOf: AS_OF, limit: 10, offset: 0 }, undefined, {
        jevClient: client, enrichWithJev: true, scanLimit: 100,
      });
      expect(first.receipt.jevCalls).toBeGreaterThan(0);
      expect(first.receipt.inputTokens).toBeGreaterThan(0);
      const calls = client.calls;
      const second = await buildWorklist(db, { asOf: AS_OF, limit: 10, offset: 0 }, undefined, {
        jevClient: client, enrichWithJev: true, scanLimit: 100,
      });
      expect(second.receipt.jevCacheHits).toBeGreaterThan(0);
      expect(client.calls).toBe(calls);
    } finally {
      db.close();
    }
  });

  it("job lifecycle: queued -> running -> done with result + receipt", async () => {
    const db = buildFixtureDbMemory();
    try {
      const job = createJob({ asOf: AS_OF, limit: 5, offset: 0 }, undefined, false);
      expect(job.status).toBe("queued");
      const done = await runJob(db, job.id);
      expect(done.status).toBe("done");
      expect(done.result?.entries.length).toBeLessThanOrEqual(5);
      expect(done.result?.receipt.ranked).toBeLessThanOrEqual(5);
      expect(getJob(job.id)?.status).toBe("done");
    } finally {
      db.close();
    }
  });
});
