import { describe, expect, it } from "vitest";
import { buildFixtureDbMemory } from "./givecampus/fixture.js";
import { DEFAULT_GIVECAMPUS_RUBRIC } from "../src/pipeline/rubric.js";
import { runGiveCampusQuery } from "../src/pipeline/run-query.js";
import type { DynamicJevClient } from "../src/pipeline/jev-evaluator.js";

class BoundaryClient implements DynamicJevClient {
  states: Record<string, unknown>[] = [];
  async systemOne(args: { state: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>; questions: Record<string, { type: string }> }) {
    this.states.push(args.state);
    const [id, question] = Object.entries(args.questions)[0]!;
    const answer = question.type === "score" ? { type: "score", score: 2.4 }
      : question.type === "choice" ? { type: "choice", choice: "event_invite" }
        : { type: "noul", noul: 0.8 };
    return { model: "test-jev", answers: { [id]: answer }, usage: { input_tokens: 5, output_tokens: 1 } };
  }
}

describe("semantic-first GiveCampus backend", () => {
  it("filters with retrieval, ranks with rubric only, and decides actions only for the final twenty", async () => {
    const db = buildFixtureDbMemory();
    const client = new BoundaryClient();
    try {
      const result = await runGiveCampusQuery(db, "Who should we reach before Giving Day and why?", {
        asOf: "2026-08-31",
        candidateCap: 3,
        questionCachePath: ":memory:",
        jevClient: client,
        compile: async () => ({ rubric: structuredClone(DEFAULT_GIVECAMPUS_RUBRIC), fallback: false, reason: null, telemetry: null }),
        embedder: {
          model: "mock-embedding",
          async embed(inputs) { return { vectors: inputs.map((_, i) => [i + 1, 1]), inputTokens: inputs.length }; },
        },
      });
      expect(result.retrieval.candidateCount).toBeLessThanOrEqual(3);
      expect(result.ranked).toHaveLength(result.retrieval.candidateCount);
      expect(result.topTwentyActions.length).toBeLessThanOrEqual(20);
      expect(result.topTwentyActions.every((decision) => decision.requestedAction === "event_invite")).toBe(true);
      for (const state of client.states) {
        expect(JSON.stringify(state)).not.toMatch(/embedding|semantic|similarity|retrieval|searchText|vector/i);
      }
      expect(result.ranked.every((candidate) => !("retrievalScore" in candidate) && !("semanticScore" in candidate))).toBe(true);
    } finally {
      db.close();
    }
  });
});
