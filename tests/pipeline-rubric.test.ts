import { describe, expect, it, vi } from "vitest";
import { compilePipelineRubric } from "../src/llm/pipeline-rubric.js";
import { DEFAULT_GIVECAMPUS_RUBRIC, FIELD_NAMES, validateCompiledRubric } from "../src/pipeline/rubric.js";

function validRubric() {
  return structuredClone(DEFAULT_GIVECAMPUS_RUBRIC);
}

describe("canonical pipeline rubric", () => {
  it("validates the safe GiveCampus rubric and exact action options", () => {
    const rubric = validateCompiledRubric(validRubric(), FIELD_NAMES);
    expect(Object.keys(rubric.tags[0]!.options).sort()).toEqual(["ask", "event_invite", "reunion_mailer", "thank_you"]);
  });

  it("rejects negative and numeric JEV questions", () => {
    const negative = validRubric();
    negative.scores[0]!.question = "Is this person not engaged?";
    expect(() => validateCompiledRubric(negative, FIELD_NAMES)).toThrow(/negative/);
    const numeric = validRubric();
    numeric.scores[0]!.question = "Did this person give more than 3 gifts?";
    expect(() => validateCompiledRubric(numeric, FIELD_NAMES)).toThrow(/numeric\/date/);
  });

  it("compiles a full rubric with one mocked LLM call", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      model: "gpt-5-mini",
      usage: { input_tokens: 10, output_tokens: 20 },
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(validRubric()) }] }],
    }), { status: 200 }));
    const result = await compilePipelineRubric("Who should we reach before Giving Day?", FIELD_NAMES, { fetchFn });
    expect(result.fallback).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back when the action vocabulary drifts", async () => {
    const invalid = validRubric();
    invalid.tags[0]!.options = { thank_you: "thank", ask: "ask" };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      model: "gpt-5-mini", usage: {},
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(invalid) }] }],
    }), { status: 200 }));
    const result = await compilePipelineRubric("query", FIELD_NAMES, { fetchFn });
    expect(result.fallback).toBe(true);
    expect(result.rubric).toEqual(DEFAULT_GIVECAMPUS_RUBRIC);
  });
});
