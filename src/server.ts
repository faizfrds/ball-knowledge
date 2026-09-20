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
import { buildWorklist } from "./givecampus/worklist.js";
import { createJob, getJob, listJobs, runJob } from "./givecampus/jobs.js";

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
      model: JEV_MODEL,
      // Boolean only — the key value is never exposed.
      jevAvailable: hasJevKey(),
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
      json(res, 200, result);
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    } finally {
      db.close();
    }
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
    const job = createJob(body.filter ?? {}, body.criterion ?? undefined, enrichWithJev);
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
