import http from "node:http";
import { openDb } from "./db.js";
import { AS_OF_DATE, DATASET_VERSION, resolveDbPath } from "./config.js";
import { getConstituentBundle, listConstituents } from "./data-access.js";

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

function router(req: http.IncomingMessage, res: http.ServerResponse, dbPath: string): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true, datasetVersion: DATASET_VERSION, asOf: AS_OF_DATE });
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
  json(res, 404, { error: "not_found" });
}

const dbPath = resolveDbPath();
const server = http.createServer((req, res) => {
  try {
    router(req, res, dbPath);
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

if (process.argv[1]?.endsWith("server.ts") || process.env.TSX === "1") {
  server.listen(PORT, () => {
    console.log(`ball-knowledge api on http://localhost:${PORT} (db=${dbPath})`);
  });
}

export { server };
