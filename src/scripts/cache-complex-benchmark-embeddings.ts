import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATASET_VERSION, REPO_ROOT, resolveDbPath } from "../config.js";
import { checkEligibility, type ConstituentEligibilityRow } from "../givecampus/eligibility.js";
import { EVIDENCE_VERSION } from "../givecampus/criterion.js";
import { loadServerEnv } from "../env.js";
import { EmbeddingCache } from "../retrieval/embedding-cache.js";
import { OpenAIEmbeddingsClient } from "../retrieval/embeddings.js";
import { buildConstituentCard } from "../retrieval/item-card.js";
import { retrieveCandidates } from "../retrieval/retrieve.js";

const AS_OF = "2025-08-31";
const GOLD_PATH = path.join(REPO_ROOT, "docs", "results", "complex-benchmark-gold-v1.json");
const CACHE_PATH = path.join(REPO_ROOT, "data", "retrieval-cache.sqlite");

function byId<T extends { constituent_id: number }>(rows: T[]): Map<number, T[]> {
  const result = new Map<number, T[]>();
  for (const row of rows) {
    const list = result.get(row.constituent_id);
    if (list) list.push(row); else result.set(row.constituent_id, [row]);
  }
  return result;
}

async function main(): Promise<void> {
  loadServerEnv();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) throw new Error("OPENAI_API_KEY is not configured");
  const gold = JSON.parse(fs.readFileSync(GOLD_PATH, "utf8")) as {
    protocol: string; asOf: string; queries: { id: string; query: string }[];
  };
  if (gold.asOf !== AS_OF || gold.queries.length !== 4) throw new Error("Frozen four-query benchmark contract is unavailable");

  const db = new Database(resolveDbPath(), { readonly: true, fileMustExist: true });
  const cache = new EmbeddingCache(CACHE_PATH);
  const started = Date.now();
  try {
    const constituents = db.prepare(`SELECT id, entity_type, deceased, deceased_date, do_not_solicit,
      email_status, phone_status FROM constituents ORDER BY id`).all() as ConstituentEligibilityRow[];
    const affiliations = byId(db.prepare(`SELECT constituent_id, affiliation_type FROM affiliations`).all() as
      { constituent_id: number; affiliation_type: string }[]);
    const degrees = byId(db.prepare(`SELECT constituent_id, class_year, degree_type FROM degrees`).all() as
      { constituent_id: number; class_year: number | null; degree_type: string | null }[]);
    const cards = constituents.flatMap((constituent) => {
      const eligibility = checkEligibility({
        constituent,
        affiliations: affiliations.get(constituent.id) ?? [],
        degrees: degrees.get(constituent.id) ?? [],
        asOf: AS_OF,
      });
      return eligibility.eligibleForContact
        ? [buildConstituentCard({ db, constituentId: constituent.id, asOf: AS_OF })]
        : [];
    });
    console.log(JSON.stringify({
      phase: "embedding_started", eligibleN: cards.length, queryN: gold.queries.length,
      model: "text-embedding-3-small", batchSize: 100, cache: path.relative(REPO_ROOT, CACHE_PATH),
    }));
    let telemetry: unknown = null;
    const retrieval = await retrieveCandidates(cards, gold.queries.map((row) => row.query), {
      candidateCap: 2_000,
      embedder: new OpenAIEmbeddingsClient({ apiKey }),
      embeddingCache: cache,
      batchSize: 100,
      datasetVersion: DATASET_VERSION,
      evidenceVersion: EVIDENCE_VERSION,
      onEmbeddingTelemetry: (value) => {
        telemetry = value;
        console.log(JSON.stringify({ phase: "embedding_complete", ...value }));
      },
    });
    console.log(JSON.stringify({
      phase: "candidate_cache_ready", eligibleN: cards.length, candidateN: retrieval.candidateCount,
      bm25RankLists: retrieval.bm25RankLists, embeddingRankLists: retrieval.embeddingRankLists,
      cacheEntries: cache.size, elapsedMs: Date.now() - started, telemetry,
    }));
  } finally {
    cache.close();
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Benchmark embedding phase failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
