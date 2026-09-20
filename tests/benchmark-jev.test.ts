import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  JEV_ABLATION_MAX_CALLS,
  JEV_LIVE_MAX_CALLS,
  buildJevStateForId,
  buildLivePool,
  costInputUsd,
  evaluatePool,
  fetchJevScoresForPool,
  genericScoreFromAnswers,
  isModelRejection,
  jevScoreFromAnswers,
  rankPoolComparators,
  rankScores,
  MapPoolCache,
  GENERIC_QUESTIONS,
} from "../src/benchmark/jev-live.js";
import type { JevClient, JevState } from "../src/givecampus/jev.js";
import { JEV_MODEL } from "../src/givecampus/jev.js";

function testDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE constituents (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL,
      email_status TEXT NOT NULL, phone_status TEXT NOT NULL,
      city TEXT, state TEXT, do_not_solicit BOOLEAN NOT NULL,
      deceased BOOLEAN NOT NULL, deceased_date TEXT, preferred_name TEXT);
    CREATE TABLE gifts (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      gift_date TEXT NOT NULL, amount NUMERIC NOT NULL, status TEXT NOT NULL,
      gift_type TEXT NOT NULL);
    CREATE TABLE interactions (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      occurred_at TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'email',
      outcome TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'outbound',
      follow_up_date TEXT, related_gift_id INTEGER, notes TEXT NOT NULL DEFAULT '');
    CREATE TABLE event_attendance (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      attended_at TEXT NOT NULL, event_id INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE career_history (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      employer TEXT NOT NULL DEFAULT '', job_title TEXT, is_current BOOLEAN NOT NULL,
      recorded_at TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT '2020-01-01');
    CREATE TABLE degrees (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      degree_type TEXT, class_year INTEGER);
    CREATE TABLE activities (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      activity_name TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY, city TEXT NOT NULL, state TEXT NOT NULL,
      starts_at TEXT NOT NULL);
  `);
  return db;
}

function seedDb(db: Database.Database, n = 60) {
  for (let i = 1; i <= n; i++) {
    db.prepare(
      `INSERT INTO constituents (id, entity_type, email_status, phone_status, city, state, do_not_solicit, deceased, deceased_date, preferred_name)
       VALUES (?, 'individual', 'deliverable', 'available', 'Boston', 'MA', 0, 0, NULL, ?)`,
    ).run(i, `Person ${i}`);
    // Staircase giving: higher ids gave more recently (so rankings differ).
    if (i % 3 !== 0) {
      db.prepare(`INSERT INTO gifts VALUES (?, ?, '2024-06-01', ?, 'paid', 'one_time')`).run(i * 10, i, i * 10);
    }
    if (i % 4 === 0) {
      db.prepare(`INSERT INTO gifts VALUES (?, ?, '2025-10-15', 50, 'paid', 'one_time')`).run(i * 10 + 1, i);
    }
    db.prepare(
      `INSERT INTO career_history VALUES (?, ?, 'Employer', ?, 1, '2024-01-01', '2020-01-01')`,
    ).run(i, i, i % 2 === 0 ? "Engineer" : null);
  }
}

/** Deterministic stub: answers derived from constituent id, no network. */
function stubClient(opts: { model?: string; rejectModels?: string[]; calls?: { n: number } } = {}): JevClient {
  return {
    async systemOne(args: { state: JevState; questions: Record<string, unknown>; model?: string }) {
      if (opts.calls) opts.calls.n += 1;
      const model = args.model ?? JEV_MODEL;
      if (opts.rejectModels?.includes(model)) throw new Error(`model_not_found: ${model} (422)`);
      const id = Number(args.state.constituent_id);
      const score = id % 4;
      return {
        model,
        answers: {
          has_recent_gift: { type: "noul", noul: id % 2 },
          has_repeat_giving: { type: "noul", noul: (id + 1) % 2 },
          title_employer_context_present: { type: "noul", noul: 1 },
          engagement_level: { type: "score", score, confidence: 0.8 },
          capacity_evidence_strength: { type: "score", score: (id + 1) % 4, confidence: 0.7 },
          permitted_action: { type: "choice", choice: "personal_outreach", confidence: 0.9 },
          general_engagement: { type: "score", score: score, confidence: 0.5 },
          general_capacity: { type: "score", score: (id + 1) % 4, confidence: 0.5 },
          suggested_action: { type: "choice", choice: "broad_invite", confidence: 0.5 },
        },
        usage: { input_tokens: 100, output_tokens: 5 },
        retries: 0,
      };
    },
  };
}

describe("jev-live pool", () => {
  it("builds a deterministic pool within budget (union, id-asc, capped)", () => {
    const db = testDb();
    seedDb(db);
    const a = buildLivePool(db, "2025-08-31", { perRanker: 10, cap: 25 });
    const b = buildLivePool(db, "2025-08-31", { perRanker: 10, cap: 25 });
    expect(a.poolIds).toEqual(b.poolIds);
    expect(a.poolIds).toEqual([...a.poolIds].sort((x, y) => x - y));
    expect(a.poolIds.length).toBeLessThanOrEqual(25);
    const union = new Set([...a.sources.trained_lr_lr_f, ...a.sources.rfm_r_heavy, ...a.sources.priority_recency_heavy]);
    expect(new Set(a.poolIds)).toEqual(new Set([...union]));
    expect(a.poolIds.length).toBeLessThanOrEqual(JEV_LIVE_MAX_CALLS);
    db.close();
  });

  it("scores headline answers deterministically with unknown renormalization", () => {
    const full = {
      engagement_level: { type: "score", score: 3 },
      capacity_evidence_strength: { type: "score", score: 3 },
      has_recent_gift: { type: "noul", noul: 1 },
      has_repeat_giving: { type: "noul", noul: 1 },
    };
    expect(jevScoreFromAnswers(full).score).toBeCloseTo(1, 10);
    // Unknown engagement excluded: remaining weights renormalize to 1.0-capacity mix.
    const partial = {
      engagement_level: { type: "score" },
      capacity_evidence_strength: { type: "score", score: 3 },
      has_recent_gift: { type: "noul", noul: 0 },
      has_repeat_giving: { type: "noul", noul: 0 },
    };
    const got = jevScoreFromAnswers(partial);
    expect(got.known).toBe(3);
    expect(got.score).toBeCloseTo((0.35 * 1 + 0.15 * 0 + 0.15 * 0) / 0.65, 10);
    // Tiebreak is id-asc.
    expect(rankScores(new Map([[1, 0.5], [2, 0.5], [3, 0.9]]), [2, 1, 3])).toEqual([3, 1, 2]);
    expect(Object.keys(GENERIC_QUESTIONS).sort()).toEqual(
      ["general_capacity", "general_engagement", "suggested_action"].sort(),
    );
    expect(genericScoreFromAnswers({ general_engagement: { type: "score", score: 2 } }).known).toBe(1);
  });

  it("state builder is as-of safe (ignores post-T0 gifts)", () => {
    const db = testDb();
    seedDb(db, 5);
    db.prepare(`INSERT INTO gifts VALUES (999, 1, '2025-09-15', 99999, 'paid', 'one_time')`).run();
    const s = buildJevStateForId(db, 1, "2025-08-31");
    expect(s.as_of_date).toBe("2025-08-31");
    expect(s.recorded_giving.lifetime_total).not.toBe(99999);
    expect(s.constituent_id).toBe("1");
    expect(s.permissions.eligible_for_solicitation).toBe(true);
    db.close();
  });
});

describe("jev-live fetching", () => {
  it("uses cache on second pass (no new live calls) and counts budget", async () => {
    const db = testDb();
    seedDb(db, 20);
    const pool = buildLivePool(db, "2025-08-31", { perRanker: 5, cap: 12 });
    const cache = new MapPoolCache();
    const calls = { n: 0 };
    const first = await fetchJevScoresForPool({
      db, poolIds: pool.poolIds, t0: "2025-08-31",
      client: stubClient({ calls }), cache, concurrency: 2,
    });
    expect(first.liveCalls).toBe(pool.poolIds.length);
    expect(calls.n).toBe(pool.poolIds.length);
    const second = await fetchJevScoresForPool({
      db, poolIds: pool.poolIds, t0: "2025-08-31",
      client: stubClient({ calls }), cache, concurrency: 2,
    });
    expect(second.liveCalls).toBe(0);
    expect(second.cacheHits).toBe(pool.poolIds.length);
    expect(calls.n).toBe(pool.poolIds.length); // no new client calls
    db.close();
  });

  it("falls back to jev-latest when the pinned model is rejected", async () => {
    const db = testDb();
    seedDb(db, 10);
    const pool = buildLivePool(db, "2025-08-31", { perRanker: 3, cap: 6 });
    const out = await fetchJevScoresForPool({
      db, poolIds: pool.poolIds.slice(0, 3), t0: "2025-08-31",
      client: stubClient({ rejectModels: [JEV_MODEL] }), cache: new MapPoolCache(),
      models: [JEV_MODEL, "jev-latest"], concurrency: 1,
    });
    expect(out.fallbackUsed).toBe(true);
    expect(out.records.every((r) => r.model === "jev-latest")).toBe(true);
    expect(isModelRejection(new Error("model_not_found: jev-1.13.0 (422)"))).toBe(true);
    expect(isModelRejection(new Error("boom"))).toBe(false);
    db.close();
  });

  it("never embeds secrets in records and respects the call budget", async () => {
    const db = testDb();
    seedDb(db, 10);
    process.env.TYPESAFE_API_KEY = "sk-test-do-not-log-12345";
    const pool = buildLivePool(db, "2025-08-31", { perRanker: 3, cap: 6 });
    const out = await fetchJevScoresForPool({
      db, poolIds: pool.poolIds, t0: "2025-08-31",
      client: stubClient(), cache: new MapPoolCache(), concurrency: 2, maxLiveCalls: 2,
    });
    expect(out.liveCalls).toBeLessThanOrEqual(2);
    expect(JSON.stringify(out.records)).not.toContain("sk-test-do-not-log-12345");
    delete process.env.TYPESAFE_API_KEY;
    expect(JEV_ABLATION_MAX_CALLS).toBeLessThanOrEqual(50);
    db.close();
  });
});

describe("jev-live pool evaluation", () => {
  it("evaluates every comparator on the same pool population", () => {
    const db = testDb();
    seedDb(db, 40);
    const pool = buildLivePool(db, "2025-08-31", { perRanker: 8, cap: 20 });
    const comps = rankPoolComparators(db, pool.poolIds, "2025-08-31");
    expect(comps.length).toBeGreaterThan(10);
    for (const c of comps) {
      expect(new Set(c.ranked)).toEqual(new Set(pool.poolIds));
    }
    const { rows, poolN } = evaluatePool(db, comps, pool.poolIds, "2025-08-31");
    expect(poolN).toBe(pool.poolIds.length);
    for (const r of rows) expect(r.metrics.populationN).toBe(pool.poolIds.length);
    expect(costInputUsd(1_000_000)).toBeCloseTo(0.042, 10);
    db.close();
  });
});
