import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/server.js";
import { clearJobs } from "../../src/givecampus/jobs.js";
import { buildFixtureDbFile } from "./fixture.js";
import type { Server } from "node:http";
import fs from "node:fs";

let server: Server;
let base = "";
const dbFile = buildFixtureDbFile();

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  clearJobs();
  server = createServer(dbFile);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  clearJobs();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  try {
    fs.unlinkSync(dbFile);
  } catch { /* ignore */ }
});

describe("API smoke", () => {
  it("GET /api/health", async () => {
    const { status, body } = await get("/api/health");
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  it("GET /api/givecampus/health exposes versions, never the key", async () => {
    const { status, body } = await get("/api/givecampus/health");
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.model).toBe("jev-1.13.0");
    expect(b.datasetVersion).toBe("1.2");
    expect(JSON.stringify(b)).not.toMatch(/sk-|TYPESAFE_API_KEY/);
  });

  it("GET /api/constituents/:id returns bundle", async () => {
    const { status, body } = await get("/api/constituents/1?asOf=2026-08-31");
    expect(status).toBe(200);
    expect((body as { features: { constituentId: number } }).features.constituentId).toBe(1);
  });

  it("GET /api/worklist ranks with a cost receipt", async () => {
    const { status, body } = await get("/api/worklist?asOf=2026-08-31&limit=5");
    expect(status).toBe(200);
    const b = body as { entries: unknown[]; receipt: Record<string, unknown> };
    expect(b.entries.length).toBeLessThanOrEqual(5);
    expect(b.receipt.asOf).toBe("2026-08-31");
  });

  it("job API: POST creates, GET polls to done, receipt serves", async () => {
    const created = await fetch(`${base}/api/worklist/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filter: { asOf: "2026-08-31", limit: 3, offset: 0 } }),
    });
    expect(created.status).toBe(202);
    const { jobId } = (await created.json()) as { jobId: string };
    let job: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const r = await get(`/api/worklist/jobs/${jobId}`);
      expect(r.status).toBe(200);
      job = r.body as Record<string, unknown>;
      if (job.status === "done" || job.status === "error") break;
      await new Promise((r2) => setTimeout(r2, 50));
    }
    expect(job.status).toBe("done");
    const receipt = await get(`/api/cost-receipt?jobId=${jobId}`);
    expect(receipt.status).toBe(200);
    expect((receipt.body as Record<string, unknown>).model).toBe("jev-1.13.0");
  });

  it("static web serving does not 404 the demo page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/html/);
  });

  it("query-job API validates the required natural-language query", async () => {
    const response = await fetch(`${base}/api/query-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "", candidateCap: 20 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "query is required" });
  });
});
