// Zero-dependency static server for web/ — serves the demo UI locally.
// Usage: node web/serve.mjs [port]   (default 4173)
// Optionally proxies /api/* to the Ball Knowledge API: API_UPSTREAM=http://localhost:3000 node web/serve.mjs
// No npm packages required.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.WEB_PORT ?? 4173);
const UPSTREAM = process.env.API_UPSTREAM ?? "http://localhost:3000";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function proxyApi(req, res) {
  const target = new URL(req.url, UPSTREAM);
  const proxy = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (up) => {
    res.writeHead(up.statusCode ?? 502, { ...up.headers, "access-control-allow-origin": "*" });
    up.pipe(res);
  });
  proxy.on("error", () => {
    const body = JSON.stringify({ error: "api_upstream_unreachable", upstream: UPSTREAM, hint: "Start the API with `npm run dev`, or use the built-in mocked rows." });
    res.writeHead(502, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
    res.end(body);
  });
  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) { proxyApi(req, res); return; }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(here, rel));
  if (!file.startsWith(here)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback for dossier deep-links like /dossier/123
      fs.readFile(path.join(here, "index.html"), (e2, buf2) => {
        if (e2 || !url.pathname.startsWith("/dossier")) { res.writeHead(404); res.end("not_found"); return; }
        res.writeHead(200, { "content-type": TYPES[".html"] });
        res.end(buf2);
      });
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`triage board on http://localhost:${PORT} (api upstream ${UPSTREAM})`));
