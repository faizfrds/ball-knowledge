import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CHARACTERISTIC_COUNT, buildCharacteristicQuestions, evaluateCharacteristic } from "../src/characteristics/question-library.js";
import {
  LocalCharacteristicClient,
  MapCharacteristicCache,
  noulVerdict,
  precomputeCharacteristics,
  SqliteCharacteristicCache,
  type PrecomputeResult,
  type Verdict,
} from "../src/characteristics/precompute.js";
import { buildJevStateForId } from "../src/benchmark/jev-live.js";
import type { JevAnswer, JevClient, JevQuestion, JevState } from "../src/givecampus/jev.js";
import { JEV_MODEL } from "../src/givecampus/jev.js";

const AS_OF = "2026-08-31";

function testDb(n = 8): Database.Database {
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
    CREATE TABLE activities (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL,
      activity_name TEXT NOT NULL);
  `);
  for (let i = 1; i <= n; i++) {
    db.prepare(
      `INSERT INTO constituents (id, entity_type, email_status, phone_status, do_not_solicit, deceased, deceased_date, preferred_name)
       VALUES (?, 'individual', 'deliverable', 'available', 0, 0, NULL, ?)`,
    ).run(i, `Person ${i}`);
    // even ids: a $1,200 gift 60 days before AS_OF; odd ids: a $40 gift 2 years before.
    const date = i % 2 === 0 ? "2026-07-02" : "2024-08-01";
    db.prepare(`INSERT INTO gifts VALUES (?, ?, ?, ?, 'paid', 'one_time')`).run(i * 10, i, date, i % 2 === 0 ? 1200 : 40);
    db.prepare(`INSERT INTO career_history VALUES (?, ?, 'Acme', ?, 1, '2024-01-01', '2020-01-01')`).run(i, i, i % 2 === 0 ? "Chief Donor Officer" : null);
    if (i % 2 === 0) {
      db.prepare(`INSERT INTO event_attendance VALUES (?, ?, '2026-05-01', 7)`).run(i, i);
    }
  }
  return db;
}

describe("characteristic question library", () => {
  it("builds exactly 100 deterministic unique noul questions", () => {
    const a = buildCharacteristicQuestions();
    const b = buildCharacteristicQuestions();
    expect(a.length).toBe(CHARACTERISTIC_COUNT);
    expect(new Set(a.map((q) => q.id)).size).toBe(CHARACTERISTIC_COUNT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const q of a) {
      expect(q.question.type).toBe("noul");
      expect(q.question.instructions.trim()).not.toBe("");
      expect((q.question.criteria as Record<string, string>).true).toBeTruthy();
      expect((q.question.criteria as Record<string, string>).false).toBeTruthy();
    }
  });

  it("code mirrors answer from the listed state", () => {
    const questions = buildCharacteristicQuestions();
    const fresh: JevState = {
      constituent_id: "1",
      dataset_version: "1.2",
      evidence_version: "ev-001",
      as_of_date: AS_OF,
      as_of_date_minus_12mo: "2025-08-31",
      permissions: { do_not_contact: false, do_not_solicit: false, eligible_for_solicitation: true },
      recorded_giving: { last_gift_date: null, last_gift_amount: null, lifetime_total: null, gift_count_24mo: 0 },
      engagement: { events: [] },
      explicit_capacity: { rating: null, source: null },
      context: { title: null, employer: null },
    };
    expect(evaluateCharacteristic(fresh, "never_gave")).toBe(true);
    expect(evaluateCharacteristic(fresh, "gave_within_30d")).toBe(false);
    expect(evaluateCharacteristic(fresh, "title_present")).toBe(false);
    expect(evaluateCharacteristic(fresh, "no_such_id")).toBe(null);
    expect(questions.length).toBe(100);
  });
});

describe("precomputeCharacteristics", () => {
  const questionSubset = buildCharacteristicQuestions().slice(0, 5);

  function stubClient(counter: { n: number }, noulFor: (id: number, questionId: string) => number): JevClient {
    return {
      async systemOne(args: { state: JevState; questions: Record<string, JevQuestion>; model?: string }) {
        counter.n += 1;
        const answers: Record<string, JevAnswer> = {};
        for (const qid of Object.keys(args.questions)) {
          answers[qid] = { type: "noul", noul: noulFor(Number(args.state.constituent_id), qid) };
        }
        return { model: args.model ?? JEV_MODEL, answers, usage: { input_tokens: 500, output_tokens: 20 }, retries: 0 };
      },
    };
  }

  const ALL_QUESTIONS = buildCharacteristicQuestions();

  async function runWith(client: JevClient, cache: MapCharacteristicCache, n = 4): Promise<PrecomputeResult> {
    const db = testDb(n);
    try {
      return await precomputeCharacteristics({
        db,
        poolIds: [1, 2],
        asOf: AS_OF,
        client,
        cache,
        questions: ALL_QUESTIONS,
        chunkSize: 30,
        concurrency: 2,
        maxLiveCalls: 1000,
      });
    } finally {
      db.close();
    }
  }

  it("derives verdicts and counts live calls once per chunk", async () => {
    const counter = { n: 0 };
    const client = stubClient(counter, (id, qid) => (qid.startsWith("gave_within") && id % 2 === 0 ? 1 : 0));
    const result = await runWith(client, new MapCharacteristicCache());
    expect(result.verdictsByConstituent.get(1)!.gave_within_30d).toBe("no");
    expect(result.verdictsByConstituent.get(2)!.gave_within_30d).toBe("yes");
    expect(result.liveCalls).toBe(2 * Math.ceil(100 / 30));
    expect(result.records.every((r) => r.questionIds.length > 0)).toBe(true);
    expect(result.verdictsByConstituent.get(1)!.engaged_recent_donor).toBe("no");
  });

  it("reuses the cache on the second run (zero live calls)", async () => {
    const counter = { n: 0 };
    const cache = new MapCharacteristicCache();
    await runWith(stubClient(counter, () => 0), cache);
    const firstCalls = counter.n;
    const second = await runWith(stubClient(counter, () => 0), cache);
    expect(counter.n).toBe(firstCalls);
    expect(second.liveCalls).toBe(0);
    expect(second.cacheHits).toBe(2 * Math.ceil(100 / 30));
    expect(second.verdictsByConstituent.get(1)!.gave_within_30d).toBe("no");
  });

  it("enforces the global live-call budget with explicit errors", async () => {
    const counter = { n: 0 };
    const db = testDb(4);
    try {
      const result = await precomputeCharacteristics({
        db,
        poolIds: [1, 2],
        asOf: AS_OF,
        client: stubClient(counter, () => 0),
        cache: new MapCharacteristicCache(),
        chunkSize: 50,
        maxLiveCalls: 1,
      });
      expect(result.liveCalls).toBe(1);
      expect(result.errors.length).toBe(3);
      expect(result.errors.every((e) => e.error === "call_budget_exhausted")).toBe(true);
      const errored = result.verdictsByConstituent.get(1)!;
      expect(Object.values(errored).every((v) => v === "uncertain" || v === "yes" || v === "no")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("mock client mirrors the code evaluation deterministically (parity)", async () => {
    const db = testDb(4);
    try {
      const result = await precomputeCharacteristics({
        db,
        poolIds: [1, 2],
        asOf: AS_OF,
        client: new LocalCharacteristicClient(),
        cache: new MapCharacteristicCache(),
        chunkSize: 30,
        maxLiveCalls: 1000,
      });
      const mockClientMirror = (id: number): Record<string, boolean | null> => {
        const state = buildJevStateForId(db, id, AS_OF);
        return Object.fromEntries(
          buildCharacteristicQuestions().map((q) => [q.id, q.codeCheck(state)]),
        );
      };
      for (const id of [1, 2]) {
        const mirror = mockClientMirror(id);
        const got: Record<string, Verdict> = result.verdictsByConstituent.get(id)!;
        for (const [qid, codeValue] of Object.entries(mirror)) {
          expect(got[qid]).toBe(codeValue == null ? "uncertain" : codeValue ? "yes" : "no");
        }
      }
      expect(result.verdictsByConstituent.get(2)!.lifetime_at_least_1000).toBe("yes");
      expect(result.verdictsByConstituent.get(1)!.gifts_24mo_at_least_1).toBe("no");
      expect(result.fallbackUsed).toBe(false);
    } finally {
      db.close();
    }
  });

  it("maps noul scores to verdicts with explicit thresholds", () => {
    expect(noulVerdict(0.9)).toBe("yes");
    expect(noulVerdict(0.7)).toBe("yes");
    expect(noulVerdict(0.5)).toBe("uncertain");
    expect(noulVerdict(0.3)).toBe("no");
    expect(noulVerdict(0.1)).toBe("no");
  });

  it("round-trips answers through the sqlite cache", async () => {
    const cache = new SqliteCharacteristicCache(":memory:");
    const key = "k1";
    cache.set(key, {
      model: JEV_MODEL,
      answers: { gave_within_90d: { type: "noul", noul: 1 } },
      usage: { input_tokens: 10, output_tokens: 2 },
      latencyMs: 5,
      retries: 0,
    });
    const got = cache.get(key)!;
    expect(got.model).toBe(JEV_MODEL);
    expect((got.answers.gave_within_90d as unknown as { noul: number }).noul).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.get("k2")).toBeNull();
    cache.close();
  });
});
