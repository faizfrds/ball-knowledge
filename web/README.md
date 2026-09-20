# Giving Day Triage Board (web/ prototype)

Dependency-free UI for the GiveCampus Ball Knowledge prototype. Plain HTML + CSS + ES modules — no npm packages, no bundler — so it can be served by any static server (including the zero-dep `serve.mjs` here) without touching the API's `package.json`.

## Run it (2 terminals)

```bash
# 1. API (repo root) — optional; the board works without it (mocked fallback)
npm run dev            # http://localhost:3000  (/api/health, /api/constituents*)

# 2. UI (repo root)
node web/serve.mjs     # http://localhost:4173  (proxies /api/* to :3000)
# or: API_UPSTREAM=http://localhost:3000 node web/serve.mjs 4173
```

Then open **http://localhost:4173**. No build step.

## What you get

- **3-pane desktop (≥1024px):** left rail (query + typed filters + rubric + as-of + run + gates) · center ranked top-20 worklist · right dossier inspector.
- **Tablet (768–1279px):** rail becomes an overlay drawer (Filters button); center + inspector split.
- **Mobile (<768px):** stepped flow — Ask → Worklist → Dossier — via the bottom tab bar; tables become cards.
- **Query / as-of / typed filters:** natural-language box plus validated chips (affiliation, class-year range, city, activity, paid-gift recency/floor, channel status, staff, campaign). As-of is capped at `2026-08-31`.
- **Rubric:** per-criterion weight (0–5, rerank only) + threshold + unknown-policy (downrank/flag/exclude; rescore path). Pill shows “Reranked” vs “Rescoring …”.
- **Progress / provisional:** staged stepper (filter → score → rank → evidence) with provisional rows (`Provisional` pill) streaming in; cancellable.
- **Ranked worklist:** rank · name/affiliation/class · why-now one-liner · action pill · priority index bar (rank only, never a probability) · evidence dots · review flag. Sort locked to rank (+ evidence-completeness secondary).
- **Dossier:** Why-person / Why-now / Action / Evidence / Missing tabs; four-state strip (eligible / priority / evidence / review); evidence chips (`table #id`); disallowed actions struck through; `review_needed` fallback with reasons.
- **Review-needed + exclusions:** toggle + banner count; Excluded tray lists deterministic pre-model gates (deceased / do-not-solicit / uncontactable / inactive staff / organization) — never silently dropped.
- **Receipt:** per-run drawer — job id, versions, as-of, eligible/screened, cache key + WARM/COLD, latency (uncached vs warm), tokens, cost, backtest delta vs paid-only RFM baseline, copy-JSON.
- **Accessibility:** landmarks, skip links, real `<table>` with caption + `aria-sort`, roving tabindex + arrow keys on rows, tablist-pattern dossier tabs, polite/assertive live regions, focus return on dialogs, 44px targets, reduced-motion + print styles.
- **Fallback states:** `API MOCK` banner when `/api/worklists` is absent (engine landing) or the API is down; loading skeletons; over-filtered empty state with one-click recovery; job-failure card with retry (same cache key) + copy-diagnostics. Server rows are normalized with safe defaults so missing fields degrade to `review_needed`/“unknown” instead of crashing.

## Manual test script (≈5 min)

1. Load `http://localhost:4173` → 20 rows stream in with provisional pills; header shows `CACHE COLD · <hash>` and `API MOCK`.
2. Click row 1 → dossier opens; cycle the 5 tabs; check Evidence chips and Missing list.
3. Toggle “Review-needed only” → banner count matches; select a flagged row → fallback rationale visible.
4. Open Excluded (header count) → 5 rows each with a gate reason.
5. Open Receipt → latency/tokens/cache key/backtest delta; Copy receipt JSON.
6. Move a rubric weight → “Reranked” pill, order shifts, no rescore; change a threshold → full rescoring run.
7. Set as-of to 2026-09-01 → inline error blocks the run; reset to 2026-08-31.
8. Narrow to 768px / 390px widths → drawer rail, card list, bottom tabs, dossier sheet.
9. `http://localhost:4173/?smoke=1` → in-page smoke panel (12 checks).
10. `node web/smoke.mjs` → file + content + live HTTP checks (needs `serve.mjs` running for HTTP part).

## Files

| file | purpose |
|---|---|
| `index.html` | shell: header badges, 3 panes, drawers, live regions |
| `styles.css` | restrained theme + responsive + print |
| `js/app.js` | orchestrator: run/progress/rerank/render/dossier/a11y |
| `js/api.js` | API client + capability probe + row normalizer (tolerates missing fields) |
| `js/mock.js` | seeded deterministic 20-row fallback + excluded + receipt |
| `js/smoke.js` | browser self-test (`?smoke=1`) |
| `serve.mjs` | zero-dep static server + `/api` proxy (node stdlib only) |
| `smoke.mjs` | zero-dep node smoke (`node web/smoke.mjs`) |

## API contract consumed (tolerant)

`POST /api/worklists` → `{ jobId }`; `GET /api/worklists/:id?include=excluded` → `{ ranked[], excluded[], receipt, cache }`; `…/stream` (SSE, optional); `GET /api/constituents/:id/explanation?asOf=` + `GET /api/constituents/:id` for dossier enrichment. All live shapes pass through `normalizeRow()` — absent fields fall back to `review_needed`, “unknown”, or 0-completeness rather than failing. Today only `/api/health` + `/api/constituents*` exist in `src/server.ts`, so the board runs mocked until the engine slice lands; no `src/` changes were made for this checkpoint.
