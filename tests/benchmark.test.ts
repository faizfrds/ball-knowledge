import { describe, expect, it } from "vitest";
import fs from "node:fs";
import Database from "better-sqlite3";
import { getEligiblePopulation } from "../src/benchmark/eligibility.js";
import { buildAllFeatures, loadOutcomes } from "../src/benchmark/features.js";
import { evaluateRanking, ndcgAtK, precisionAtK } from "../src/benchmark/metrics.js";
import {
  buildFixedRankers,
  mulberry32,
  rank,
  RANDOM_SEED,
} from "../src/benchmark/algorithms.js";
import { loadJevScores, rankJev } from "../src/benchmark/jev.js";
import { trainLogistic, predictProb, toArray } from "../src/benchmark/model.js";

const T0 = "2025-08-31";

function testDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE constituents (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL,
      email_status TEXT NOT NULL, phone_status TEXT NOT NULL,
      city TEXT, state TEXT, do_not_solicit BOOLEAN NOT NULL,
      deceased BOOLEAN NOT NULL, deceased_date TEXT);
    CREATE TABLE gifts (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      gift_date TEXT NOT NULL, amount NUMERIC NOT NULL, status TEXT NOT NULL,
      gift_type TEXT NOT NULL);
    CREATE TABLE interactions (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      occurred_at TEXT NOT NULL, outcome TEXT NOT NULL, follow_up_date TEXT);
    CREATE TABLE event_attendance (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      attended_at TEXT NOT NULL);
    CREATE TABLE career_history (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      job_title TEXT, is_current BOOLEAN NOT NULL, recorded_at TEXT NOT NULL);
    CREATE TABLE degrees (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      degree_type TEXT, class_year INTEGER);
    CREATE TABLE activities (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      activity_name TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY, city TEXT NOT NULL, state TEXT NOT NULL,
      starts_at TEXT NOT NULL);
  `);
  return db;
}

function addConstituent(
  db: Database.Database,
  id: number,
  over: Partial<Record<string, unknown>> = {},
) {
  const base: Record<string, unknown> = {
    id, entity_type: "individual", email_status: "deliverable",
    phone_status: "available", city: "Boston", state: "MA",
    do_not_solicit: 0, deceased: 0, deceased_date: null, ...over,
  };
  db.prepare(
    `INSERT INTO constituents (id, entity_type, email_status, phone_status, city, state, do_not_solicit, deceased, deceased_date)
     VALUES (@id, @entity_type, @email_status, @phone_status, @city, @state, @do_not_solicit, @deceased, @deceased_date)`,
  ).run(base);
}

describe("leakage guards", () => {
  it("ignores gifts dated after T0 in features", () => {
    const db = testDb();
    addConstituent(db, 1);
    db.prepare(`INSERT INTO gifts VALUES (1, 1, '2025-08-01', 100, 'paid', 'one_time')`).run();
    db.prepare(`INSERT INTO gifts VALUES (2, 1, '2025-09-15', 99999, 'paid', 'one_time')`).run();
    const feats = buildAllFeatures(db, [{ id: 1, city: "Boston", state: "MA" }], T0);
    const f = feats.get(1)!;
    expect(f.paidTotal5y).toBe(100);
    expect(f.maxSinglePaid).toBe(100);
    db.close();
  });

  it("excludes recurring_parent headers but counts installments", () => {
    const db = testDb();
    addConstituent(db, 1);
    db.prepare(`INSERT INTO gifts VALUES (1, 1, '2024-01-01', 12000, 'paid', 'recurring_parent')`).run();
    db.prepare(`INSERT INTO gifts VALUES (2, 1, '2024-02-01', 1000, 'paid', 'installment')`).run();
    db.prepare(`INSERT INTO gifts VALUES (3, 1, '2024-03-01', 1000, 'paid', 'installment')`).run();
    const feats = buildAllFeatures(db, [{ id: 1, city: null, state: null }], T0);
    expect(feats.get(1)!.paidCount5y).toBe(2);
    expect(feats.get(1)!.paidTotal5y).toBe(2000);
    db.close();
  });

  it("uses recorded_at, not started_at, for career signals", () => {
    const db = testDb();
    addConstituent(db, 1);
    // Promotion started before T0 but learned after T0 -> must NOT bump why-now.
    db.prepare(
      `INSERT INTO career_history VALUES (1, 1, 'Vice President', 1, '2025-09-15')`,
    ).run();
    const feats = buildAllFeatures(db, [{ id: 1, city: null, state: null }], T0);
    expect(feats.get(1)!.whyNow).not.toBe("career_signal");
    db.close();
  });

  it("outcome window excludes pledged/failed and post-window gifts", () => {
    const db = testDb();
    addConstituent(db, 1);
    db.prepare(`INSERT INTO gifts VALUES (1, 1, '2025-09-01', 50, 'pledged', 'pledge')`).run();
    db.prepare(`INSERT INTO gifts VALUES (2, 1, '2025-09-01', 60, 'failed', 'one_time')`).run();
    db.prepare(`INSERT INTO gifts VALUES (3, 1, '2025-12-01', 70, 'paid', 'one_time')`).run();
    const { donors } = loadOutcomes(db, T0, 90);
    expect(donors.size).toBe(0);
    db.prepare(`INSERT INTO gifts VALUES (4, 1, '2025-09-01', 80, 'paid', 'one_time')`).run();
    expect(loadOutcomes(db, T0, 90).donors.has(1)).toBe(true);
    db.close();
  });
});

describe("eligibility population", () => {
  it("applies E1+E2+E3 with deceased_date as-of check, keeps affiliation-less", () => {
    const db = testDb();
    addConstituent(db, 1); // eligible, no affiliation row anywhere
    addConstituent(db, 2, { deceased: 1, deceased_date: "2020-01-01" });
    addConstituent(db, 3, { deceased_date: "2025-01-01" }); // flag 0 but date <= T0
    addConstituent(db, 4, { do_not_solicit: 1 });
    addConstituent(db, 5, { email_status: "missing", phone_status: "missing" });
    addConstituent(db, 6, { entity_type: "organization" });
    addConstituent(db, 7, { deceased_date: "2025-09-15" }); // dies after T0: eligible
    const pop = getEligiblePopulation(db, T0).map((p) => p.id);
    expect(pop).toEqual([1, 7]);
    db.close();
  });

  it("every ranker sees the identical population", () => {
    const db = testDb();
    for (let i = 1; i <= 30; i++) {
      addConstituent(db, i);
      db.prepare(`INSERT INTO gifts VALUES (${i}, ${i}, '2024-06-01', ${i * 10}, 'paid', 'one_time')`).run();
    }
    const pop = getEligiblePopulation(db, T0);
    const feats = buildAllFeatures(db, pop, T0);
    const ids = pop.map((p) => p.id);
    for (const r of buildFixedRankers()) {
      expect(rank(r, feats, ids)).toHaveLength(ids.length);
      expect(new Set(rank(r, feats, ids))).toEqual(new Set(ids));
    }
    db.close();
  });
});

describe("metrics", () => {
  it("computes precision@k by hand", () => {
    const donors = new Set([2, 5]);
    const ranked = [1, 2, 3, 4, 5];
    expect(precisionAtK(ranked, donors, 2).p).toBe(0.5);
    expect(precisionAtK(ranked, donors, 5).p).toBe(0.4);
  });

  it("computes binary NDCG@k by hand", () => {
    // Perfect ranking -> 1.0
    expect(ndcgAtK([1, 2, 3], new Set([1, 2]), 3)).toBeCloseTo(1, 10);
    // Hit at position 2 only: 1/log2(3) / (1 + 1/log2(3))
    const got = ndcgAtK([9, 1, 3], new Set([1]), 3);
    expect(got).toBeCloseTo(1 / Math.log2(3) / 1, 10);
    // No donors -> 0
    expect(ndcgAtK([1, 2], new Set(), 2)).toBe(0);
  });

  it("reports paid$ as descriptive alongside rank metrics", () => {
    const m = evaluateRanking([1, 2, 3], new Set([2]), new Map([[2, 250]]));
    expect(m.precisionAt20).toBeCloseTo(1 / 3, 4);
    expect(m.amountTop100).toBe(250);
    expect(m.amountPopulation).toBe(250);
    expect(m.donorCount).toBe(1);
  });
});

describe("deterministic selection", () => {
  it("seeded random is stable and seed-pinned", () => {
    const a = mulberry32(RANDOM_SEED ^ 1);
    const b = mulberry32(RANDOM_SEED ^ 1);
    expect(a()).toBe(b());
  });

  it("rank() is deterministic with id-asc tiebreaks", () => {
    const db = testDb();
    for (let i = 1; i <= 10; i++) addConstituent(db, i);
    const pop = getEligiblePopulation(db, T0);
    const feats = buildAllFeatures(db, pop, T0);
    const ids = pop.map((p) => p.id);
    for (const r of buildFixedRankers()) {
      const first = rank(r, feats, ids);
      const second = rank(r, feats, [...ids].reverse());
      expect(second).toEqual(first);
    }
    // All-identical features -> id order (tiebreak), not input order.
    const rev = rank(buildFixedRankers()[0]!, feats, [...ids].reverse());
    const fwd = rank(buildFixedRankers()[0]!, feats, ids);
    expect(rev).toEqual(fwd);
    db.close();
  });

  it("logistic training is deterministic and learns a separating direction", () => {
    const mk = (id: number, v: number) => ({
      constituentId: id, daysSinceLastPaid: 10, paidCount5y: 1,
      paidTotal5y: 100, maxSinglePaid: 100,
      r: v, f: v, m: v, e: 0, n: 0, c: 0,
      recencyUnknown: false, whyNow: "none" as const,
    });
    const feats = [mk(1, 0.9), mk(2, 0.8), mk(3, 0.1), mk(4, 0.0)];
    const labels = new Map([[1, 1], [2, 1], [3, 0], [4, 0]]);
    const a = trainLogistic(feats, labels, { lr: 0.5, l2: 0.1, epochs: 200 });
    const b = trainLogistic(feats, labels, { lr: 0.5, l2: 0.1, epochs: 200 });
    expect(a.weights).toEqual(b.weights);
    const model = { hyperId: "t", means: a.means, stds: a.stds, weights: a.weights, bias: a.bias };
    expect(predictProb(model, mk(9, 0.95))).toBeGreaterThan(predictProb(model, mk(9, 0.05)));
    expect(toArray(mk(1, 0.5))).toHaveLength(6);
  });

  it("jev hook ranks external scores deterministically and validates coverage", () => {
    const header = "constituent_id,score\n1,0.9\n2,0.9\n3,0.1\n";
    const p = "C:\\Users\\ekagr\\AppData\\Local\\Temp\\banyancode\\jev_test.csv";
    fs.writeFileSync(p, header);
    const jev = loadJevScores(p, [1, 2, 3]);
    expect(rankJev(jev, [3, 2, 1])).toEqual([1, 2, 3]); // tie -> id asc
    expect(() => loadJevScores(p, [1, 2])).toThrow(/exactly the eligible population/);
    fs.rmSync(p);
  });
});

describe("real database smoke", () => {
  const dbPath = "D:\\ball-knowledge\\data\\givecampus.sqlite";
  it("eligible population is non-empty and stable across cutoffs", () => {
    if (!fs.existsSync(dbPath)) return;
    const db = new Database(dbPath, { readonly: true });
    const a = getEligiblePopulation(db, "2024-08-31");
    const b = getEligiblePopulation(db, "2025-08-31");
    expect(a.length).toBeGreaterThan(10000);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
    db.close();
  });
});
