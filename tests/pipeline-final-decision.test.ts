import { describe, expect, it } from "vitest";
import type { DynamicJevClient } from "../src/pipeline/jev-evaluator.js";
import {
  buildFinalDecisionQuestion,
  evaluateFinalTopTwentyActions,
  FINAL_ACTIONS,
  type FinalDecisionCandidate,
} from "../src/pipeline/final-decision.js";

class ChoiceClient implements DynamicJevClient {
  calls: { state: Record<string, unknown>; questionId: string; labels: string[] }[] = [];
  constructor(private readonly choice: string) {}
  async systemOne(args: {
    state: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>;
    questions: Record<string, { type: "noul" | "score" | "choice"; instructions: string; criteria: unknown }>;
  }) {
    const [questionId, question] = Object.entries(args.questions)[0]!;
    this.calls.push({ state: args.state, questionId, labels: Object.keys(question.criteria as object) });
    return {
      model: "test-jev",
      answers: { [questionId]: { type: "choice", choice: this.choice } },
      usage: { input_tokens: 5, output_tokens: 1 },
    };
  }
}

function candidates(count: number): FinalDecisionCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    constituentId: i + 1,
    rank: i + 1,
    disposition: "eligible" as const,
    fields: { contactability: "email_valid", engagement_events: [`event-${i + 1}`], retrievalScore: 99 },
    evidenceRefs: { contactability: [`constituents:${i + 1}`] },
    eligibleForContact: true,
    eligibleForSolicitation: true,
    permittedActions: [...FINAL_ACTIONS],
  }));
}

describe("final top-twenty Choice decision", () => {
  it("evaluates no more than the final top twenty using exactly the four action labels", async () => {
    const client = new ChoiceClient("event_invite");
    const fields = ["contactability", "engagement_events"] as const;
    const q = buildFinalDecisionQuestion([...fields]);
    expect(Object.keys(q.rubric.tags[0]!.options).sort()).toEqual([...FINAL_ACTIONS].sort());
    const result = await evaluateFinalTopTwentyActions({
      rankedCandidates: candidates(25), fields: [...fields], asOf: "2026-08-31", client,
    });
    expect(result).toHaveLength(20);
    expect(client.calls).toHaveLength(20);
    expect(result[0]!.constituentId).toBe(1);
    expect(result[19]!.constituentId).toBe(20);
    expect(client.calls[0]!.state).toEqual({ contactability: "email_valid", engagement_events: ["event-1"] });
    expect(client.calls[0]!.labels.sort()).toEqual([...FINAL_ACTIONS].sort());
    expect(result.every((x) => x.action === "event_invite" && x.status === "decided")).toBe(true);
  });

  it("blocks an ask forbidden by deterministic solicitation eligibility", async () => {
    const client = new ChoiceClient("ask");
    const [candidate] = candidates(1);
    const result = await evaluateFinalTopTwentyActions({
      rankedCandidates: [{ ...candidate!, eligibleForSolicitation: false, permittedActions: ["thank_you", "event_invite"] }],
      fields: ["contactability"], asOf: "2026-08-31", client,
    });
    expect(result[0]).toMatchObject({ requestedAction: "ask", action: "thank_you", status: "decided", overridden: true });
  });

  it("does not call Jev for a contact-ineligible candidate", async () => {
    const client = new ChoiceClient("ask");
    const [candidate] = candidates(1);
    const result = await evaluateFinalTopTwentyActions({
      rankedCandidates: [{ ...candidate!, eligibleForContact: false, permittedActions: [] }],
      fields: ["contactability"], asOf: "2026-08-31", client,
    });
    expect(client.calls).toHaveLength(0);
    expect(result[0]).toMatchObject({ action: null, status: "blocked" });
  });
});
