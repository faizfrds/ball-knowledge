import { describe, expect, it } from "vitest";
import { deterministicRoute, routeQuery, type RouteClassifier } from "../src/pipeline/router.js";

describe("query router", () => {
  it("routes direct IDs and names to lookup", () => {
    expect(deterministicRoute("Show constituent #123").route).toBe("lookup");
    expect(deterministicRoute("Find Jane Smith").route).toBe("lookup");
  });

  it("routes a simple keyword query without compilation", () => {
    expect(deterministicRoute("Boston alumni").route).toBe("simple");
  });

  it("routes multi-constraint judgment to deep", () => {
    expect(deterministicRoute("Find loyal donors who are lapsed but still engaged and ready for outreach").route).toBe("deep");
  });

  it("routes group summaries to analysis", () => {
    expect(deterministicRoute("Segment every donor and summarize the groups").route).toBe("analysis");
  });

  it("escalates low-confidence model decisions one level", async () => {
    const classifier: RouteClassifier = { classify: async () => ({ route: "simple", confidence: 0.4 }) };
    expect((await routeQuery("ambiguous", { classifier })).route).toBe("deep");
  });

  it("reports wants-all and number flags", () => {
    const result = deterministicRoute("Show every donor with 3 gifts");
    expect(result.wantsAll).toBe(true);
    expect(result.hasNumber).toBe(true);
  });
});
