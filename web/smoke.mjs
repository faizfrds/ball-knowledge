// Zero-dependency smoke for web/ — file checks + optional live HTTP checks.
// Usage: node web/smoke.mjs [baseUrl]   (default http://localhost:4173; skips HTTP if unreachable)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? "http://localhost:4173";
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`); };

const required = ["index.html", "styles.css", "js/app.js", "js/api.js", "js/mock.js", "js/smoke.js", "serve.mjs", "README.md"];
for (const f of required) ok(`file exists: ${f}`, fs.existsSync(path.join(here, f)));

const html = fs.readFileSync(path.join(here, "index.html"), "utf8");
for (const s of ["worklist-table", "dossier-tabs", "receipt-drawer", "excluded-drawer", "progress", "asof-input", "sr-progress", "smoke-panel"]) {
  ok(`index.html contains #${s}`, html.includes(s));
}
ok("no npm imports in app.js", !/from ["'](react|vue|lodash|axios)/.test(fs.readFileSync(path.join(here, "js/app.js"), "utf8")));
ok("no banned claims (propensity / likely-to-give / expected revenue)", !/likely to give|propensity|expected revenue|% likely|probability of giving|best time to (call|give)/i.test(html + fs.readFileSync(path.join(here, "js/mock.js"), "utf8") + fs.readFileSync(path.join(here, "js/app.js"), "utf8")));

// Optional live checks against serve.mjs (tolerate connection refused = server not started).
try {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  const res = await fetch(`${base}/index.html`, { signal: ctl.signal });
  clearTimeout(t);
  ok(`HTTP GET ${base}/index.html`, res.ok, `status ${res.status}`);
  const body = await res.text();
  ok("served HTML has worklist table", body.includes("worklist-table"));
} catch (err) {
  console.log(`SKIP — live HTTP checks (${err.cause?.code ?? err.message}); start with: node web/serve.mjs`);
}
console.log(`\nsmoke: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
