import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateRubricForCandidate,
  type DynamicJevClient,
  type DynamicRubric,
} from "../src/pipeline/jev-evaluator.js";
import { SqliteQuestionAnswerCache } from "../src/pipeline/question-cache.js";
import { rankByRubric } from "../src/pipeline/rank.js";

class RecordingClient implements DynamicJevClient {
  calls: { state: Record<string, unknown>; questionId: string; question: Record<string, unknown> }[] = [];
  constructor(private readonly answers: Record<string, Record<string, unknown>>) {}
  async systemOne(args: { state: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>; questions: Record<string, unknown> }) {
    const questionId = Object.keys(args.questions)[0]!;
    this.calls.push({ state: args.state, questionId, question: args.questions[questionId] as Record<string, unknown> });
    return {
      model: "test-jev",
      answers: { [questionId]: this.answers[questionId] ?? { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 8, output_tokens: 2 },
    };
  }
}

function rubric(overrides: Partial<DynamicRubric> = {}): DynamicRubric {
  return {
    id: "test", version: "1",
    gates: [
      { id: "reachable", question: "Is the person reachable?", trueCriteria: "Evidence shows reachable", falseCriteria: "Evidence shows unreachable", fields: ["contactability"], threshold: 0.8, unknownPolicy: "review" },
    ],
    scores: [
      { id: "engagement", question: "How strong is engagement?", levels: ["Low", "Medium", "High"], fields: ["engagement_events"], weight: 1 },
    ],
    bonuses: [],
    tags: [],
    ...overrides,
  };
}

describe("dynamic Jev evaluation", () => {
  it("sends each question only its declared raw fields and ignores embedding/retrieval inputs", async () => {
    const client = new RecordingClient({
      "gate:reachable": { type: "noul", noul: 0.95 },
      "score:engagement": { type: "score", score: 1.5 },
    });
    const result = await evaluateRubricForCandidate({
      constituentId: 7,
      fields: {
        contactability: "email_valid",
        engagement_events: ["attended alumni panel"],
        employer: "Acme",
        embedding: [0.1, 0.2],
        semanticSimilarity: 0.99,
        retrievalScore: 123,
      },
      rubric: rubric(), asOf: "2026-08-31", client,
      evidenceRefs: { contactability: ["constituents:7"], engagement_events: ["attendance:12"] },
    });

    expect(client.calls.map((c) => c.state)).toEqual([
      { contactability: "email_valid" },
      { engagement_events: ["attended alumni panel"] },
    ]);
    expect(result.disposition).toBe("eligible");
    expect(result.scores.engagement.value).toBe(0.75);
    expect(result.gates.reachable.evidenceRefs).toEqual(["constituents:7"]);
  });

  it("treats gates as independent pass/fail decisions and does not multiply probabilities", async () => {
    const r = rubric({ gates: [
      { id: "a", question: "A?", trueCriteria: "Yes", falseCriteria: "No", fields: ["contactability"], threshold: 0.8, unknownPolicy: "review" },
      { id: "b", question: "B?", trueCriteria: "Yes", falseCriteria: "No", fields: ["state"], threshold: 0.8, unknownPolicy: "review" },
    ] });
    const client = new RecordingClient({ "gate:a": { noul: 0.9 }, "gate:b": { noul: 0.1 } });
    const result = await evaluateRubricForCandidate({
      constituentId: 8, fields: { contactability: "reachable", state: "MA", engagement_events: [] },
      rubric: r, asOf: "2026-08-31", client,
    });
    expect(result.gates.a.status).toBe("pass");
    expect(result.gates.b.status).toBe("fail");
    expect(result.disposition).toBe("excluded");
    expect(result.scores).toEqual({});
  });

  it("uses the persisted per-question cache and leaves weight/threshold edits call-free", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "question-cache-"));
    const dbPath = path.join(dir, "answers.sqlite");
    const cache = new SqliteQuestionAnswerCache(dbPath);
    const client = new RecordingClient({ "gate:reachable": { noul: 0.9 }, "score:engagement": { score: 1 } });
    const base = {
      constituentId: 9, fields: { contactability: "reachable", engagement_events: ["event"] },
      asOf: "2026-08-31", client, cache,
    };
    const first = await evaluateRubricForCandidate({ ...base, rubric: rubric() });
    const weightEdited = rubric({ scores: [{ ...rubric().scores[0]!, weight: 4 }] });
    const second = await evaluateRubricForCandidate({ ...base, rubric: weightEdited });
    expect(client.calls).toHaveLength(2);
    expect(first.gates.reachable.cacheHit).toBe(false);
    expect(second.gates.reachable.status).toBe("pass");
    expect(second.gates.reachable.cacheHit).toBe(true);
    expect(second.scores.engagement.cacheHit).toBe(true);
    expect(second.disposition).toBe("eligible");
    const thresholdEdited = rubric({ gates: [{ ...rubric().gates[0]!, threshold: 0.95 }] });
    const third = await evaluateRubricForCandidate({ ...base, rubric: thresholdEdited });
    expect(third.gates.reachable.status).toBe("unknown");
    expect(third.gates.reachable.cacheHit).toBe(true);
    expect(third.scores).toEqual({});
    expect(third.disposition).toBe("review");
    expect(cache.size).toBe(2);
    cache.close();

    const reopened = new SqliteQuestionAnswerCache(dbPath);
    expect(reopened.size).toBe(2);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reruns only an edited question while unrelated candidate fields do not affect its cache key", async () => {
    const cache = new SqliteQuestionAnswerCache(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "question-edit-")), "q.sqlite"));
    const client = new RecordingClient({ "gate:reachable": { noul: 0.9 }, "score:engagement": { score: 1 } });
    const base = { constituentId: 10, fields: { contactability: "reachable", engagement_events: ["event"] }, rubric: rubric(), asOf: "2026-08-31", client, cache };
    await evaluateRubricForCandidate(base);
    const edited = rubric({ gates: [{ ...rubric().gates[0]!, question: "Does current evidence show a reachable channel?" }] });
    await evaluateRubricForCandidate({ ...base, fields: { ...base.fields, employer: "Different" }, rubric: edited });
    expect(client.calls.map((x) => x.questionId).sort()).toEqual(["gate:reachable", "gate:reachable", "score:engagement"]);
    cache.close();
  });
});

describe("rubric ranker", () => {
  it("ranks from rubric values and optional code prior, with unknown-downrank candidates in a lower tier", () => {
    const rows = [
      { constituentId: 1, disposition: "eligible" as const, rubricScore: 0.7, unknownDownrankCount: 1, evidenceCompleteness: 0.8 },
      { constituentId: 2, disposition: "eligible" as const, rubricScore: 0.2, unknownDownrankCount: 0, evidenceCompleteness: 1 },
    ].map((x) => ({ ...x, gates: {}, scores: {}, bonuses: {}, tags: {}, reviewReasons: [] }));
    const ranked = rankByRubric(rows, { predictiveGivingPrior: true, priorByConstituent: new Map([[1, 1], [2, 0]]) });
    expect(ranked.map((x) => x.constituentId)).toEqual([2, 1]);
    expect(ranked[1]!.finalRankScore).toBeCloseTo(0.8);
  });
});
