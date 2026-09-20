import { describe, expect, it } from "vitest";
import { buildConstituentCard, formatQuestionState, type ConstituentCard } from "../src/retrieval/item-card.js";
import { EmbeddingCache } from "../src/retrieval/embedding-cache.js";
import { rankBm25 } from "../src/retrieval/bm25.js";
import { retrieveCandidates } from "../src/retrieval/retrieve.js";
import { reciprocalRankFusion } from "../src/retrieval/rrf.js";
import { buildFixtureDbMemory } from "./givecampus/fixture.js";

function card(id: number, text: string, city = "Boston"): ConstituentCard {
  return {
    constituentId: id,
    asOf: "2026-08-31",
    searchText: text,
    fields: { city, title: `Title ${id}`, gift_recency_band: "within 90 days" },
    evidenceRefs: { city: [`constituents:${id}`] },
    hash: `card-${id}`,
  };
}

describe("retrieval foundations", () => {
  it("ranks matching documents with BM25 and fuses rank lists deterministically", () => {
    const docs = [
      { id: 2, text: "lapsed donor stewardship gift" },
      { id: 1, text: "lapsed donor gift gift gift" },
      { id: 3, text: "event volunteer" },
    ];
    expect(rankBm25("lapsed donor gift", docs).map((row) => row.id)).toEqual([1, 2]);
    expect(reciprocalRankFusion([[2, 1], [1, 3]], 60).map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it("projects only the question's listed fields into Jev state", () => {
    const source = card(1, "secretly irrelevant", "Boston");
    const state = formatQuestionState(source, ["city", "gift_recency_band"]);
    expect(state).toEqual({ city: "Boston", gift_recency_band: "within 90 days" });
    expect(JSON.stringify(state)).not.toMatch(/semantic|embedding|score|searchText|evidenceRefs|constituentId/i);
  });

  it("builds as-of-safe cards and omits names, contact values, and raw interaction notes", () => {
    const db = buildFixtureDbMemory();
    try {
      const oldCard = buildConstituentCard({ db, constituentId: 1, asOf: "2025-08-31" });
      expect(oldCard.asOf).toBe("2025-08-31");
      expect(oldCard.fields.title).toBe("Program Manager");
      expect(oldCard.fields.gift_recency_band).toBe("91-365 days");
      expect(oldCard.searchText).not.toMatch(/Healthy Donor|a@example\.edu|2025-09|\bnotes?\b/i);
      expect(oldCard.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(oldCard.evidenceRefs.title).toContain("career_history:1");
      expect(() => buildConstituentCard({ db, constituentId: 1, asOf: "2099-01-01" })).toThrow(/future_asof/);
    } finally {
      db.close();
    }
  });

  it("applies typed filters before candidate selection and returns all survivors below the cap", async () => {
    const result = await retrieveCandidates(
      [card(1, "stewardship gift"), card(2, "event invite", "Cambridge")],
      ["stewardship gift"],
      { candidateCap: 10, filters: [{ field: "city", op: "eq", value: "Boston" }] },
    );
    expect(result.filteredCount).toBe(1);
    expect(result.usedAllSurvivors).toBe(true);
    expect(result.candidates.map((item) => item.constituentId)).toEqual([1]);
    expect(result.embeddingRankLists).toBe(0);
  });

  it("uses embedding ranks only to select a capped candidate pool and caches vectors", async () => {
    const cache = new EmbeddingCache(":memory:");
    const cards = [card(1, "ordinary community record"), card(2, "another ordinary record")];
    const vectorsByText = new Map<string, number[]>([
      ["lapsed donor", [1, 0]],
      [cards[0]!.searchText, [0, 1]],
      [cards[1]!.searchText, [0.9, 0.1]],
    ]);
    let liveBatches = 0;
    const embedder = {
      model: "mock-embedding",
      async embed(inputs: readonly string[]) {
        liveBatches += 1;
        return { vectors: inputs.map((input) => vectorsByText.get(input) ?? [0, 0]), inputTokens: inputs.length * 3 };
      },
    };
    try {
      const first = await retrieveCandidates(cards, ["lapsed donor"], {
        candidateCap: 1, embedder, embeddingCache: cache, batchSize: 10,
      });
      expect(first.candidates.map((item) => item.constituentId)).toEqual([2]);
      expect(first.embeddingRankLists).toBe(1);
      expect(first.embedding?.liveInputs).toBe(3);
      expect("score" in first.candidates[0]!).toBe(false);

      const second = await retrieveCandidates(cards, ["lapsed donor"], {
        candidateCap: 1, embedder, embeddingCache: cache, batchSize: 10,
      });
      expect(second.embedding?.cacheHits).toBe(3);
      expect(second.embedding?.liveInputs).toBe(0);
      expect(liveBatches).toBe(1);
    } finally {
      cache.close();
    }
  });
});
