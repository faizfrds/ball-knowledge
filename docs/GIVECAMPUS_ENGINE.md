# GiveCampus engine / API slice

Branch: `feat/givecampus-worklist`. Deterministic worklist ranking with optional
Jev enrichment. Priority index is a **0–100 rank only** — never a probability,
never expected revenue.

## Pipeline (per constituent, as-of T0, default `2026-08-31`)

1. **Typed filter** (`src/givecampus/criterion.ts`) — `parseWorklistFilter` /
   `parseCriterion` validate; filters bind as SQL parameters. No executable
   generated filter strings exist anywhere.
2. **Eligibility** (`eligibility.ts`, gates E1–E6) — deceased-date historical
   semantics (future `deceased_date` = alive at T0; flag without date = dead),
   `do_not_solicit`, status-only reachability, org exclusion, LEFT-JOIN
   affiliation retention, current-student as solicitation-only restriction.
   Ineligible rows are never scored and never call Jev.
3. **Actions** (`actions.ts`) — THANK / INVITE / SOLICIT / CULTIVATE /
   RESEARCH with fatigue + open-ask collision rules; tie-break
   THANK > INVITE > SOLICIT > CULTIVATE > RESEARCH; fallback `review_needed`.
4. **Priority index** (`scoring.ts`) — `0.25R + 0.20F + 0.20M + 0.15E +
   0.15N + 0.05C`, per-criterion unknowns, completeness, dormant/review flags.
   Capacity cites recorded giving; title/employer ≤ 0.1 weight, never a gate.
5. **Evidence** (`evidence.ts`) — row-id refs + explicit missing-data panel.
6. **Jev (optional)** (`jev.ts`) — official `@typesafe-ai/sdk`, pinned
   `jev-1.13.0`, retries (2, 408/429/5xx, 500ms→5s + jitter, respect
   Retry-After), usage/latency telemetry. Missing key → safe
   `{available:false}` fallback. Advisory only: code gates override forbidden
   picks (`gate_override`). Tests inject `MockJevClient`; no browser key.
7. **Cache** (`cache.ts` + `makeCacheKey`) — keyed by
   dataset/evidence/state/question/model/as-of. Criterion edits rescore;
   weight edits rerank with no new Jev calls.

## API (`src/server.ts`)

- `GET /api/givecampus/health` — versions + `jevAvailable` / `llmAvailable` booleans (never keys); includes `rankingMethod` / `rankingVersion`
- `GET /api/worklist?asOf&limit&city&state&affiliationType` — sync page (limit ≤ 50); `?explainTop=1` adds one batched top≤20 explanation with safe fallback, usage in `receipt.llm*`
- `POST /api/worklist/jobs` (`{filter, criterion?, enrichWithJev?, explainTop?}`) → `{jobId}` (background-ish; poll below)
- `GET /api/worklist/jobs`, `GET /api/worklist/jobs/:id`, `GET /api/cost-receipt?jobId=`
- `POST /api/rubric` (`{query, availableFields}`) — NL → typed rubric, one LLM call, safe default fallback (never throws for content)
- Web-client aliases for `web/js/api.js`: `POST /api/worklists` (probe-aware; maps UI payload to the same job engine) and `GET /api/worklists/:id` (engine entries mapped to the UI RankedRow shape; SSE stream intentionally absent — the UI falls back to polling)
- `/` + non-`/api` paths serve `web/` statically (read-only; UI owned elsewhere)
- `.env.local` loads server-side only (`src/env.ts`); values never enter responses

## Ordering + receipts

- Default order is the frozen dev-selected logistic ranker
  (`src/givecampus/frozen-lr.ts`, `trained_lr_lr_f`, rank-only `rankScore`
  in (0,1) over the six code priority subscores, unknowns → 0).
  Deterministic eligibility/actions/evidence are untouched; the 0–100
  priority index is retained per row for display. No winner claims —
  held-out numbers are report-only and live outside this slice.
- Every receipt identifies `rankingMethod` / `rankingVersion`, Jev usage
  (`jevCalls`, `jevCacheHits`, `inputTokens` / `outputTokens`), and LLM
  explainer usage (`llmCalls`, `llmInputTokens`, `llmOutputTokens`,
  `llmModel`, `llmFallback`).

## Tests

`tests/givecampus/`: eligibility (10), actions (9), scoring/filter/cache (10),
Jev contract (5), worklist integration + jobs over a seeded fixture DB (5),
API smoke incl. static serving (6). Full suite: 54 pass.
