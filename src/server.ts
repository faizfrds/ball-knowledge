import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "./db.js";
import {
  AS_OF_DATE,
  DATASET_VERSION,
  REPO_ROOT,
  resolveDbPath,
} from "./config.js";
import { getConstituentBundle, listConstituents } from "./data-access.js";
import { loadServerEnv, hasJevKey } from "./env.js";
import { DEFAULT_CRITERION, EVIDENCE_VERSION, SCORING_VERSION } from "./givecampus/criterion.js";
import { JEV_MODEL } from "./givecampus/jev.js";
import { FROZEN_RANKING_ID, FROZEN_RANKING_VERSION } from "./givecampus/frozen-lr.js";
import { buildWorklist, type WorklistEntry } from "./givecampus/worklist.js";
import { createJob, explainTopEntries, getJob, listJobs, runJob } from "./givecampus/jobs.js";
import { compileRubric } from "./llm/rubric.js";
import { hasOpenAiKey } from "./llm/config.js";
import { createQueryJob, getQueryJob, listQueryJobs, runQueryJob, cancelQueryJob } from "./pipeline/jobs.js";
import { EmbeddingCache } from "./retrieval/embedding-cache.js";
import { OpenAIEmbeddingsClient } from "./retrieval/embeddings.js";

loadServerEnv();

const PORT = Number(process.env.PORT ?? 3000);

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req: http.IncomingMessage, cap = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Serve web/ statically (read-only; never modified by the API). */
function serveWeb(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const webRoot = path.join(REPO_ROOT, "web");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(webRoot, rel));
  if (!file.startsWith(webRoot)) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": body.length,
  });
  if (req.method === "GET") res.end(body);
  else res.end();
  return true;
}

/** Map one engine entry onto the web client's RankedRow shape (tolerated fields only). */
function toUiRow(e: WorklistEntry): Record<string, unknown> {
  const triggers = [...e.whyNow, ...e.reviewReasons].filter(Boolean);
  return {
    rank: e.rank,
    constituentId: e.constituentId,
    displayName: e.name,
    primaryAffiliation: null,
    classYear: null,
    city: e.city,
    state: e.state,
    eligibility: e.eligibleForSolicit ? "eligible" : "solicit_restricted",
    priorityIndex: e.priorityIndex,
    rankScore: e.rankScore,
    rankingMethod: e.rankingMethod,
    action: e.action,
    actionRationale: triggers.length > 0 ? triggers.join("; ") : "Held for review — see evidence refs.",
    disallowedActions: [],
    whyNow: e.whyNow.length > 0 ? e.whyNow.join("; ") : "No temporal trigger as of T0.",
    evidenceCompleteness: e.completeness,
    reviewNeeded: { needed: e.reviewNeeded, reasons: e.reviewReasons },
    criteria: [],
    missing: e.missing.map((m) => ({ field: m, implication: "Engine missing-data panel — flagged for research." })),
    evidenceRefs: e.evidenceRefs,
  };
}

async function router(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dbPath: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true, datasetVersion: DATASET_VERSION, asOf: AS_OF_DATE });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/givecampus/health") {
    json(res, 200, {
      ok: true,
      datasetVersion: DATASET_VERSION,
      asOf: AS_OF_DATE,
      scoringVersion: SCORING_VERSION,
      evidenceVersion: EVIDENCE_VERSION,
      criterion: DEFAULT_CRITERION.id,
      criterionVersion: DEFAULT_CRITERION.version,
      rankingMethod: FROZEN_RANKING_ID,
      rankingVersion: FROZEN_RANKING_VERSION,
      model: JEV_MODEL,
      // Booleans only — key values are never exposed.
      jevAvailable: hasJevKey(),
      llmAvailable: hasOpenAiKey(),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/constituents") {
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const db = openDb(dbPath);
    try {
      json(res, 200, { asOf: AS_OF_DATE, rows: listConstituents(db, { limit, offset }) });
    } finally {
      db.close();
    }
    return;
  }
  const m = url.pathname.match(/^\/api\/constituents\/(\d+)$/);
  if (req.method === "GET" && m) {
    const db = openDb(dbPath);
    try {
      const asOf = url.searchParams.get("asOf") ?? AS_OF_DATE;
      json(res, 200, getConstituentBundle(db, Number(m[1]), asOf));
    } catch (err) {
      json(res, 404, { error: (err as Error).message });
    } finally {
      db.close();
    }
    return;
  }

  // Synchronous worklist (small pages; larger scans belong in jobs).
  // Default ordering is the frozen dev-selected ranker (rank only).
  // ?explainTop=1 explains the returned top<=20 in one batched call with
  // safe fallback when OpenAI is missing; usage lands in receipt.llm*.
  if (req.method === "GET" && url.pathname === "/api/worklist") {
    const db = openDb(dbPath);
    try {
      const filter: Record<string, unknown> = {
        asOf: url.searchParams.get("asOf") ?? AS_OF_DATE,
        limit: Math.min(Number(url.searchParams.get("limit") ?? 20), 50),
        offset: Number(url.searchParams.get("offset") ?? 0),
      };
      for (const k of ["city", "state", "affiliationType"] as const) {
        const v = url.searchParams.get(k);
        if (v) filter[k] = v;
      }
      const result = await buildWorklist(db, filter, undefined, { enrichWithJev: false });
      if (url.searchParams.get("explainTop") === "1") {
        const explained = await explainTopEntries(result);
        result.receipt.llmCalls = explained.llm.calls;
        result.receipt.llmInputTokens = explained.llm.inputTokens;
        result.receipt.llmOutputTokens = explained.llm.outputTokens;
        result.receipt.llmModel = explained.llm.model;
        result.receipt.llmFallback = explained.llm.fallback;
        json(res, 200, { ...result, explanations: explained.explanations, llm: explained.llm });
      } else {
        json(res, 200, result);
      }
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    } finally {
      db.close();
    }
    return;
  }

  // NL -> typed rubric (one LLM call; safe default fallback on any error,
  // including a missing OPENAI_API_KEY — never throws for content reasons).
  if (req.method === "POST" && url.pathname === "/api/rubric") {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req)) as Record<string, unknown>;
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
      return;
    }
    const outcome = await compileRubric(
      typeof body.query === "string" ? body.query : "",
      Array.isArray(body.availableFields) ? (body.availableFields as { name: string; kind: string }[]) : [],
    );
    json(res, 200, outcome);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/query-jobs") {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req)) as Record<string, unknown>;
      const job = createQueryJob({
        query: typeof body.query === "string" ? body.query : "",
        asOf: typeof body.asOf === "string" ? body.asOf : undefined,
        candidateCap: body.candidateCap === undefined ? undefined : Number(body.candidateCap),
      });
      const db = openDb(dbPath);
      const key = process.env.OPENAI_API_KEY?.trim();
      const embeddingCache = key ? new EmbeddingCache() : undefined;
      const embedder = key ? new OpenAIEmbeddingsClient({ apiKey: key }) : undefined;
      runQueryJob(db, job.id, { embedder, embeddingCache }).finally(() => {
        embeddingCache?.close();
        db.close();
      });
      json(res, 202, { jobId: job.id, status: job.status });
    } catch (error) {
      json(res, 400, { error: (error as Error).message });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/query-jobs") {
    json(res, 200, { jobs: listQueryJobs().map((job) => ({
      id: job.id, status: job.status, stage: job.stage, progress: job.progress,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
    })) });
    return;
  }
  const queryJobMatch = url.pathname.match(/^\/api\/query-jobs\/([\w-]+)$/);
  if (req.method === "GET" && queryJobMatch) {
    const job = getQueryJob(queryJobMatch[1]!);
    if (!job) json(res, 404, { error: "query_job_not_found" });
    else json(res, 200, job);
    return;
  }
  const cancelQueryJobMatch = url.pathname.match(/^\/api\/query-jobs\/([\w-]+)\/cancel$/);
  if (req.method === "POST" && cancelQueryJobMatch) {
    const job = cancelQueryJob(cancelQueryJobMatch[1]!);
    if (!job) json(res, 404, { error: "query_job_not_found" });
    else json(res, 200, { jobId: job.id, status: job.status });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/worklist/jobs") {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req)) as Record<string, unknown>;
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
      return;
    }
    const enrichWithJev = body.enrichWithJev === true;
    const explainTop = body.explainTop === true;
    const job = createJob(body.filter ?? {}, body.criterion ?? undefined, enrichWithJev, explainTop);
    // Background-ish: start without awaiting; client polls GET below.
    const db = openDb(dbPath);
    runJob(db, job.id).finally(() => db.close());
    json(res, 202, { jobId: job.id, status: job.status });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/worklist/jobs") {
    json(res, 200, {
      jobs: listJobs().map((j) => ({
        id: j.id,
        status: j.status,
        progress: j.progress,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      })),
    });
    return;
  }
  const mj = url.pathname.match(/^\/api\/worklist\/jobs\/([\w-]+)$/);
  if (req.method === "GET" && mj) {
    const job = getJob(mj[1]!);
    if (!job) {
      json(res, 404, { error: "job_not_found" });
      return;
    }
    json(res, 200, job);
    return;
  }
  // ---- Web-client aliases (Giving Day Triage Board, web/js/api.js) ----
  // Thin mapping onto the same job engine above: same deterministic
  // eligibility/actions/evidence, same frozen rank order, same receipts.
  // No new scoring, no new ranking, no LLM here. The UI probes
  // POST /api/worklists, polls GET /api/worklists/:id, and falls back to
  // polling when the SSE stream 404s — all tolerated below.
  if (req.method === "POST" && url.pathname === "/api/worklists") {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req)) as Record<string, unknown>;
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
      return;
    }
    if (body.probe === true) {
      json(res, 200, { ok: true });
      return;
    }
    const filters = (body.filters ?? {}) as Record<string, unknown>;
    const cities = Array.isArray(filters.cities) ? (filters.cities as unknown[]) : [];
    const affils = Array.isArray(filters.affiliationTypes) ? (filters.affiliationTypes as unknown[]) : [];
    const filter: Record<string, unknown> = {
      asOf: typeof body.asOf === "string" ? body.asOf : AS_OF_DATE,
      limit: Math.min(Number(body.limit ?? 20) || 20, 50),
      offset: 0,
    };
    if (typeof cities[0] === "string" && cities[0]) filter.city = cities[0];
    if (typeof affils[0] === "string" && affils[0]) filter.affiliationType = affils[0];
    const job = createJob(filter, undefined, false, false);
    const db = openDb(dbPath);
    runJob(db, job.id).finally(() => db.close());
    json(res, 202, { jobId: job.id, status: job.status });
    return;
  }
  const mw = url.pathname.match(/^\/api\/worklists\/([\w-]+)$/);
  if (req.method === "GET" && mw) {
    const job = getJob(mw[1]!);
    if (!job) {
      json(res, 404, { error: "job_not_found" });
      return;
    }
    json(res, 200, {
      jobId: job.id,
      status: job.status === "done" ? "complete" : job.status,
      ranked: (job.result?.entries ?? []).map(toUiRow),
      excluded: [],
      receipt: job.result?.receipt ?? null,
      cache: { hit: false, key: job.id },
      progress: job.result ? { eligibleN: job.result.receipt.eligible } : null,
      ...(job.explanations ? { explanations: job.explanations } : {}),
    });
    return;
  }

  const mc = url.pathname.match(/^\/api\/cost-receipt$/);
  if (req.method === "GET" && mc) {
    const jobId = url.searchParams.get("jobId");
    if (!jobId) {
      json(res, 400, { error: "jobId required" });
      return;
    }
    const job = getJob(jobId);
    if (!job || !job.result) {
      json(res, 404, { error: "receipt_not_ready" });
      return;
    }
    json(res, 200, job.result.receipt);
    return;
  }

  if (serveWeb(req, res)) return;
  json(res, 404, { error: "not_found" });
}

const dbPath = resolveDbPath();

/** Create a server bound to a specific DB (tests use a temp fixture DB). */
export function createServer(dbPathForServer: string): http.Server {
  return http.createServer((req, res) => {
    router(req, res, dbPathForServer).catch((err) =>
      json(res, 500, { error: (err as Error).message }),
    );
  });
}

const server = createServer(dbPath);

if (process.argv[1]?.endsWith("server.ts") || process.env.TSX === "1") {
  server.listen(PORT, () => {
    console.log(`ball-knowledge api on http://localhost:${PORT} (db=${dbPath})`);
  });
}

export { server };
