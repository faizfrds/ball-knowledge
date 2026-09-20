import { describe, expect, it, vi } from "vitest";
import {
  buildLlmRubricInputs,
  evaluateLlmRubricCandidate,
  FUNDRAISING_ACTIONS,
  MapLlmRubricCache,
} from "../src/benchmark/llm-rubric-adapter.js";
import type { DynamicRubric } from "../src/pipeline/jev-evaluator.js";
import { formatQuestionState } from "../src/retrieval/item-card.js";

const rubric: DynamicRubric = {
  id: "benchmark-v1",
  version: "1",
  gates: [{
    id: "reachable",
    question: "Does the record show a contactable constituent?",
    trueCriteria: "A contact method is recorded",
    falseCriteria: "No contact method is recorded",
    fields: ["contactability", "city"],
    threshold: 0.7,
    unknownPolicy: "review",
  }],
  scores: [{
    id: "relationship",
    question: "How strong is the demonstrated relationship?",
    levels: ["Little evidence", "Some evidence", "Strong evidence"],
    fields: ["gift_frequency_band", "engagement_events"],
    weight: 1,
  }],
  bonuses: [],
  tags: [{
    id: "next_action",
    question: "Which single fundraising action fits this constituent now?",
    options: {
      thank_you: "Send a stewardship thank-you",
      event_invite: "Invite to an event",
      reunion_mailer: "Send a reunion mailer",
      ask: "Make a direct fundraising ask",
    },
    fields: ["gift_recency_band", "class_year", "solicitation_fatigue_band"],
  }],
};

const fields = {
  city: "Boston",
  contactability: "email",
  gift_frequency_band: "2-4",
  engagement_events: ["Alumni weekend"],
  gift_recency_band: "2-5 years",
  class_year: 2010,
  solicitation_fatigue_band: "none in 90 days",
};

function responseFetch(action: string, calls: string[] = []) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({
      model: "test-model",
      output_text: JSON.stringify({ answers: {
        "gate:reachable": { noul: 0.95 },
        "score:relationship": { score: 2 },
        "tag:next_action": { choice: action },
      } }),
      usage: { input_tokens: 50, output_tokens: 12 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("LLM rubric benchmark adapter", () => {
  it("projects exactly the same per-question raw field scopes as the Jev item-card formatter", () => {
    const inputs = buildLlmRubricInputs(fields, rubric);
    const card = {
      constituentId: 42,
      asOf: "2025-08-31",
      searchText: "must never be copied into question state",
      fields,
      evidenceRefs: {},
      hash: "card-hash",
    };
    const criteria = [
      ...rubric.gates.map((criterion) => ["gate", criterion] as const),
      ...rubric.scores.map((criterion) => ["score", criterion] as const),
      ...rubric.bonuses.map((criterion) => ["bonus", criterion] as const),
      ...rubric.tags.map((criterion) => ["tag", criterion] as const),
    ];
    for (const [kind, criterion] of criteria) {
      const input = inputs.find((item) => item.id === `${kind}:${criterion.id}`)!;
      expect(input.state).toEqual(formatQuestionState(card, criterion.fields));
    }
    expect(inputs.map((item) => Object.keys(item.state).sort())).toEqual([
      ["city", "contactability"],
      ["engagement_events", "gift_frequency_band"],
      ["class_year", "gift_recency_band", "solicitation_fatigue_band"],
    ]);
  });

  it("sends one candidate per request and excludes embeddings and retrieval metadata", async () => {
    const requestBodies: string[] = [];
    const fetchFn = responseFetch("ask", requestBodies);
    const result = await evaluateLlmRubricCandidate({
      candidate: {
        candidateId: 42,
        fields: {
          ...fields,
          embedding: [0.1, 0.2, 0.3],
          retrievalScore: 0.99,
          semanticRank: 1,
          otherCandidate: { candidateId: 43, city: "Elsewhere" },
        },
      },
      rubric,
      asOf: "2025-08-31",
      options: { apiKey: "test-key", fetchFn },
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const sent = requestBodies[0]!;
    expect(sent).not.toContain("embedding");
    expect(sent).not.toContain("retrievalScore");
    expect(sent).not.toContain("semanticRank");
    expect(sent).not.toContain("otherCandidate");
    expect(sent).not.toContain("candidateId");
    expect(result.candidateId).toBe(42);
    expect(result.action).toBe("ask");
  });

  it("returns the four fundraising action labels and captures cache telemetry", async () => {
    for (const action of FUNDRAISING_ACTIONS) {
      const fetchFn = responseFetch(action);
      const result = await evaluateLlmRubricCandidate({
        candidate: { candidateId: action, fields },
        rubric,
        asOf: "2025-08-31",
        options: { apiKey: "test-key", fetchFn },
      });
      expect(result.action).toBe(action);
      expect(result.disposition).toBe("eligible");
      expect(result.rubricScore).toBe(1);
      expect(result.telemetry).toMatchObject({ model: "test-model", inputTokens: 50, outputTokens: 12, cacheHit: false });
    }

    const cache = new MapLlmRubricCache();
    const fetchFn = responseFetch("thank_you");
    const args = {
      candidate: { candidateId: 7, fields }, rubric, asOf: "2025-08-31",
      options: { apiKey: "test-key", fetchFn, cache },
    };
    const first = await evaluateLlmRubricCandidate(args);
    const second = await evaluateLlmRubricCandidate(args);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(first.telemetry.cacheHit).toBe(false);
    expect(second.telemetry).toMatchObject({ cacheHit: true, inputTokens: 0, outputTokens: 0, cachedInputTokens: 50, cachedOutputTokens: 12 });
    expect(cache).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });
});
