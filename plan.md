# plan.md

## Full-codebase review (2026-09-20)

GiveCampus MIT Hackathon project (`ball-knowledge`), branch `feat/givecampus-worklist`.
Review performed by reading the working tree directly (engine, benchmark, retrieval,
pipeline, characteristics, llm, server/web, scripts, tests, docs, config). Typecheck and
test suite were executed as part of this review (results in the dedicated section below).

### 1. Architecture overview

| Module | Role | State |
|---|---|---|
| `src/config.ts`, `src/env.ts`, `src/db.ts`, `src/normalize.ts`, `src/ingest.ts` | Data foundation: constants (`AS_OF_DATE=2026-08-31`, dataset v1.2), `.env.local` loader, hardened SQLite open, CSV normalize/parse (fail-closed headers/widths), 15-table ingest with atomic publish + FK/allocation/post-death checks | Committed, stable |
| `src/data-access.ts`, `src/features.ts`, `src/evidence.ts` | Parameterized as-of-safe reads, pure feature calcs (`summarizeGifts`/`summarizeInteractions`), evidence refs | Committed, stable |
| `src/givecampus/eligibility.ts` | Deterministic E1–E6 gates (`checkEligibility`) | Committed, stable |
| `src/givecampus/actions.ts` | Deterministic A-rules (`decideActions`, `needsResearch`); code is authoritative over Jev | Committed, stable |
| `src/givecampus/scoring.ts` | Priority index 0–100 (rank-only), component subscores r/f/m/e/n/c | Committed, stable |
| `src/givecampus/criterion.ts`, `cache.ts` | Typed filter/criterion contract, `makeCacheKey`, stableStringify, in-memory cache | Committed, stable |
| `src/givecampus/jev.ts` | Server-side TypeSafe Jev client + headline questions + `evaluateWithJev` | Committed, stable |
| `src/givecampus/frozen-lr.ts` | Frozen dev-selected LR rank model (`trained_lr_lr_f`), ordinal rank only | Committed, stable |
| `src/givecampus/store.ts` | Bound-parameter SQL readers for engine/benchmark/pipeline | Committed, stable |
| `src/givecampus/worklist.ts` | Product worklist orchestrator (filter→eligibility→actions→score→evidence→rank) | Committed, stable |
| `src/givecampus/jobs.ts` | Background-ish worklist jobs + `explainTopEntries` (top≤20 only) | Committed, stable |
| `src/benchmark/{eligibility,features,algorithms,model,metrics,run,jev}.ts` | Structured ranking benchmark: TRAIN/DEV/HELD-OUT protocol, LR grid, RFM/priority comparators, descriptive metrics | Committed, stable |
| `src/benchmark/jev-live.ts` | Bounded live Jev reranker-pool eval + `buildJevStateForId` | Committed, stable |
| `src/benchmark/llm-rubric-adapter.ts` | OpenAI Responses adapter mirroring Jev per-criterion field scope | Committed; small uncommitted prompt tweak |
| `src/retrieval/{bm25,embeddings,embedding-cache,item-card,rrf,retrieve}.ts` | Hybrid candidate selection: BM25 + embeddings + RRF, `ConstituentCard`, typed filters, embedding cache | Committed in `47c1fa6` |
| `src/pipeline/{router,rubric,pipeline-rubric bridge?}` | Semantic-first query pipeline (see below) | Committed in `47c1fa6` |
| `src/pipeline/{jev-evaluator,question-cache,rank,final-decision,run-query,jobs}.ts` | Dynamic Jev rubric evaluation, SQLite per-question cache, rubric-only ranking, separate final action Choice, orchestrator, query jobs | Committed; `final-decision.ts` has an uncommitted change |
| `src/llm/{client,rubric,explain,pipeline-rubric,config,index,smoke}.ts` | OpenAI Responses client with retries/telemetry, legacy headline rubric compiler, top-20 explainer, semantic-pipeline rubric compiler | Committed, stable |
| `src/characteristics/{question-library,precompute}.ts` | 100 yes/no characteristic bank + deterministic code mirrors; chunked precompute with SQLite/Map cache, call budget, model fallback | Committed; script/test uncommitted tweaks |
| `src/scripts/*` | ingest, benchmark, benchmark-jev, benchmark-semantic-jev, benchmark-complex-offline, **benchmark-complex-live (new)**, cache-complex-benchmark-embeddings, precompute-characteristics | Mostly committed |
| `src/server.ts` | Dependency-free HTTP API (engine + rubric + query jobs + worklist aliases) and static `web/` serving | Committed, stable |
| `web/*` | Dependency-free Giving Day Triage Board (probes `/api/worklists`, mocks when unreachable) | Committed, stable |
| `tests/*` (19 files) | Vitest unit/integration (engine, benchmark, retrieval, pipeline, llm, characteristics, ingest, api) | Green |
| `docs/*` | HANDOFF, BENCHMARK, LLM, ENGINE, DATA_FOUNDATION, `results/` frozen + generated reports | Committed; `complex-benchmark-live.*` untracked |
| `20260919_GiveCampus_MIT_Hackathon-.../` + `.zip` | Read-only reference CSV/schema package | **Already tracked** (22 paths incl. zip), contrary to the handoff doc |

Boundary summary: three largely independent stacks share the same SQLite dataset and
`criterion.ts` primitives:
1. **Engine/product** (`givecampus/*` + `server.ts` + `web/`): frozen LR ordering, deterministic actions.
2. **Structured benchmark** (`benchmark/*`): eligibility/features/LR/RFM comparison.
3. **Semantic-first pipeline** (`retrieval/*` + `pipeline/*` + `llm/*`): NL→rubric→hybrid retrieval→dynamic Jev→code rank→final action. Exposed only via `/api/query-jobs`; **not** wired into the web UI or `buildWorklist`.

### 2. Verified green (typecheck + tests)

Executed on 2026-09-20 (working tree, PowerShell 5.1):

- `npx tsc --noEmit -p tsconfig.json` → **exit 0**, no diagnostics.
- `npx vitest run` → **19 test files passed, 144 tests passed, 0 failed** (≈8.8s).
  Notable: `tests/ingest.test.ts` 15 tests (~6.7s, dominant cost); `tests/llm.test.ts` 19 tests;
  `tests/benchmark.test.ts` 14 tests; `tests/characteristics.test.ts` 8 tests; pipeline tests
  (`run-query`, `jev`, `router`, `rubric`, `final-decision`) all pass with mocked clients.

No network is required by the suite (Jev/OpenAI/embeddings are all injected).

### 3. Current in-flight state per subsystem

- **Working-tree delta at review time** (differs from the task brief): `src/pipeline/*`,
  `src/retrieval/*`, `src/llm/*`, `src/characteristics/*` are **already committed** in
  `47c1fa6`, not uncommitted. The actual uncommitted set was:
  - `M src/pipeline/final-decision.ts` — adds `actionOptions` parameter to
    `buildFinalDecisionQuestion` / `evaluateFinalTopTwentyActions` (per-query action wording).
  - `M src/scripts/precompute-characteristics.ts` — removes dead locals/imports (`noulVerdict`, `yesCount`, odd `questionIds.map`).
  - `M tests/characteristics.test.ts` — replaces a narrow mock assertion with a full
    code-mirror **parity** test across all 100 characteristics.
  - `?? src/scripts/benchmark-complex-live.ts` (new, 385 lines) — full-corpus semantic+BM25
    vs Jev vs OpenAI final-action comparison.
  - `?? docs/results/complex-benchmark-live.json` / `.md` — generated live report.
  - During the review, a **concurrent writer** additionally modified
    `src/benchmark/llm-rubric-adapter.ts` (system-prompt hardening: "return exactly one
    supplied option key… Never invent a label or abstain") and created
    `data/characteristics/characteristics-2026-08-31.{json,md}` in **live_jev** mode.
- **Pipeline**: router, rubric contract, dynamic Jev evaluator, per-question SQLite cache,
  rank, and final decision are implemented and unit-tested. `run-query.ts` is a working
  orchestrator but has no UI surface.
- **Retrieval**: BM25/RRF/embedding cache/item cards complete; `retrieveCandidates` is used by
  `run-query.ts` and by benchmark scripts, never by `buildWorklist`.
- **Characteristics**: 100-question bank + precompute runner complete; the just-added live
  output (`data/characteristics/`) is generated but **not gitignored**.
- **Benchmark**: offline + live complex runners exist; `package.json` wires only
  `benchmark:complex:offline`.
- **LLM**: `llm-rubric-adapter.ts` prompt tweak is uncommitted and unverified against a live
  model (the mocked tests pass regardless).

### 4. Risks and gaps (honest, with references)

**Leakage / as-of correctness**

1. **`buildWorklist` never enforces the dataset as-of cap.** `parseWorklistFilter` accepts any
   `asOf` in `2000-01-01..2030-01-01` (`src/givecampus/criterion.ts:93`), while the dataset
   contract is `AS_OF_DATE="2026-08-31"` (`src/config.ts:8`). `buildWorklist` binds that value
   straight into SQL (`src/givecampus/worklist.ts:165-169`) without calling `assertAsOf`
   (contrast `src/pipeline/run-query.ts:97`, which does). A request with `asOf=2029-01-01` can
   therefore read rows the dataset contract forbids.
2. **`sort: "priority_desc"` is a lie.** `WorklistFilter.sort` is declared/validated
   (`src/givecampus/criterion.ts:67,111,127`) but `listCandidateConstituents` always emits
   `ORDER BY c.id` (`src/givecampus/store.ts:108`). Any caller trusting the sort contract gets
   insertion order.
3. **`runGiveCampusQuery` scan is id-ordered and truncating.** `buildEligibleCards` asks for
   `sort:"priority_desc"` but passes `scanLimit` (default 20 000) as the SQL `LIMIT`
   (`src/pipeline/run-query.ts:201`), so only the lowest-id slice is ever considered when the
   population exceeds the cap — reintroducing the exact ordering bias the semantic pipeline
   claims to avoid.
4. **Characteristic precompute output is not gitignored.** `precompute-characteristics.ts`
   defaults to `--out data/characteristics` (`src/scripts/precompute-characteristics.ts:80`)
   and writes `poolIds` plus `verdictsByConstituent` keyed by raw constituent id
   (`:162-193`). `.gitignore` only covers `data/*.sqlite*`, and `git check-ignore` confirms
   `data/characteristics/*.json` is **not** ignored. A live run has already produced
   `data/characteristics/characteristics-2026-08-31.json` (85 KB, 20 real ids). Direct
   ID-leak-into-git vector, inconsistent with the repo-wide "no constituent ids in committed
   outputs" claim (`docs/SEMANTIC_FIRST_PIPELINE_HANDOFF.md` non-negotiables; live report
   `outputsContainConstituentIds: false`).
5. **`JevState.constituent_id` is sent to the model.** `JevState` (`src/givecampus/jev.ts:28`)
   includes the surrogate id, and both `buildJevState` (`src/givecampus/worklist.ts:125`) and
   `buildJevStateForId` (`src/benchmark/jev-live.ts:290`) populate it. Not raw PII, but it is
   an identifier crossing the model boundary for no answer-quality reason.
6. **Embedding cache misses `evidenceVersion` in `loadLocalVectors`.** The offline benchmark
   reconstructs cache keys with defaults (`src/scripts/benchmark-complex-offline.ts:202-213`)
   while `retrieveCandidates` writes them from `options.evidenceVersion ?? EVIDENCE_VERSION`
   (`src/retrieval/retrieve.ts:309-310`). Currently both resolve to `ev-001`, so it works, but a
   version bump would silently make the offline cache look "missing" instead of erroring.

**Cache keying / correctness**

7. **Per-question cache is keyed by `constituentId`**, so two constituents with byte-identical
   scoped state never share an answer (`src/pipeline/jev-evaluator.ts:263-266`). Safe, but
   under-reuses the cache the precompute step exists to warm.
8. **`SqliteQuestionAnswerCache.get` performs a write on every read**
   (`UPDATE … hit_count + 1`, `src/pipeline/question-cache.ts:69`) on a connection opened
   without WAL/busy_timeout (`:37-39`) — avoidable write contention for a pure read path.
9. **Three parallel "24-month" definitions.** `buildJevState` labels a *2-year* window
   `gift_count_24mo` (`worklist.ts:325-330`), `buildJevStateForId` does the same
   (`jev-live.ts:272-273`), while the item card's `gift_frequency_band` uses **5 years**
   (`item-card.ts:109-110,126`). The name and the semantics disagree; any rubric that reasons
   about "24 months" gets different evidence depending on which builder produced the state.
10. **`question-library.ts` mixed unknown semantics.** The interface documents "`null` = unknown
    evidence" (`src/characteristics/question-library.ts:19`), but `lastAmountAtLeast`/`lastAmountUnder`
    return `false` on missing amount (`:101-108`), while `titleIs` returns `null` (`:80-85`).
    The `lifetime_under_*` "No" text also contradicts the code (which returns true when the
    field is missing, `:311-321`).

**Error handling / robustness**

11. **No cancellation for worklist jobs.** `runJob` never checks a cancelled state and there is
    no cancel function (`src/givecampus/jobs.ts:92-144`); only query jobs have `cancelQueryJob`
    (`src/pipeline/jobs.ts:51`). Progress is synthetic (`:104-110`) and unrelated to work done.
12. **Unauthenticated, billable endpoints.** `server.ts` runs with no auth and
    `access-control-allow-origin: *` (`:32`); `/api/query-jobs` and `/api/rubric` trigger OpenAI
    /Jev calls. Fine for a hackathon demo, a real exposure if ever hosted.
13. **N+1 reads in card building.** `buildEligibleCards` builds a full item card (≈10 prepared
    statements incl. per-attendance event lookups, `src/retrieval/item-card.ts:118-123`) for
    every contact-eligible constituent up to the scan cap, before retrieval narrows anything.
    At 14k eligible this is thousands of serialized queries per query job.
14. **SDK option shapes are inconsistent and untested.** `TypesafeRouteClassifier` passes
    `timeout` + `retry` (`router.ts:39-40`), `TypesafeJevClient` passes `timeout` +
    `retryPolicy` (`jev.ts:176-185`), `TypesafeDynamicJevClient` passes `timeout` + `retry`
    with a `Set` for `httpStatuses` (`jev-evaluator.ts:91-100`). The mock tests never exercise
    the real SDK, so at least one shape is likely silently ignored.
15. **`server.ts` web-root check lacks a separator boundary.** `file.startsWith(webRoot)`
    (`server.ts:86`) would also accept a sibling directory whose name starts with `web`; low
    impact today but worth `path.relative`-based hardening (as `isPathInsideDir` already does
    in `src/config.ts:136-139`).

**Duplication / type safety / boundaries**

16. **Triplicated field allowlists:** `FIELD_NAMES` (`pipeline/rubric.ts:8`),
    `PIPELINE_FIELDS` (`pipeline/jev-evaluator.ts:7`), and `FIELD_SET`
    (`benchmark/llm-rubric-adapter.ts:106`) must be kept in sync by hand.
17. **Four action vocabularies:** `FINAL_ACTIONS` (`pipeline/final-decision.ts:10`),
    `FUNDRAISING_ACTIONS` (`benchmark/llm-rubric-adapter.ts:14`), local `ACTIONS`
    (`scripts/benchmark-complex-live.ts:38`), and the Jev `permitted_action` options
    (`givecampus/jev.ts:115-127`). No single source of truth.
18. **Duplicated rubric criterion types:** `DynamicRubric` (`pipeline/jev-evaluator.ts:51-58`)
    restates the criterion shapes declared as `CompiledRubric` (`pipeline/rubric.ts:71-81`);
    the adapter re-derives gate/score logic a third time (`benchmark/llm-rubric-adapter.ts:209-276`).
19. **Bottom-of-file import** in `src/pipeline/final-decision.ts:155` (after executable code).
    Legal TS, poor hygiene — a sign of a rushed edit.
20. **`llm-rubric-adapter.ts` prompt tweak is uncommitted and unverified.** The live benchmark
    already shows the LLM comparator at **0.0000 exact-action accuracy on all four queries**
    (`docs/results/complex-benchmark-live.md:22-28`) while Jev reaches 0.06–0.78. Either the
    model is not returning valid `<tag>:final_action` answers or the adapter's option keys are
    mismatched; the uncommitted prompt change tries to fix symptoms without a root-cause test.

**Missing scripts / repo hygiene**

21. **`package.json` wires only one of several runnable scripts.** Present: `benchmark:complex:offline`.
    Missing: `benchmark:complex:live`, `benchmark:semantic-jev`, `benchmark:jev`,
    `cache:complex-embeddings`, `precompute:characteristics` (`package.json:10-19`).
22. **`data/benchmark/*` is tracked despite docs saying it is gitignored.**
    `docs/BENCHMARK.md:149` claims the JSON is gitignored; `git ls-files data` shows
    `data/benchmark/benchmark_2025-08-31.{json,md}` are tracked. Doc drift.
23. **Stale/junk directories:** `D/` and `D7000/` each contain only a copied
    `.banyancode/trace/*.jsonl` (mis-set `cwd` artifacts). They are effectively ignored via the
    nested `.banyancode/.gitignore`, so they never appear in `git status`, but they pollute the tree.
24. **Reference package already committed contrary to the handoff doc.** The handoff states the
    reference dir + zip are "intentionally untracked"
    (`docs/SEMANTIC_FIRST_PIPELINE_HANDOFF.md:30-33`), but both are tracked (22 paths). The 13.7 MB
    directory + 2.1 MB zip are in history; nothing to do now beyond noting the inconsistency.
25. **`npm run setup` is not idempotent.** `ingest` refuses to overwrite an existing DB without
    `--force` (`src/ingest.ts:152-154`), so `setup` fails on a warmed checkout;
    `scripts/setup.ps1:9` also runs `npm run test -- --run`, which is ambiguous.

**Test coverage gaps**

26. No tests for `src/server.ts` semantic endpoints (`/api/query-jobs`, `/api/rubric`),
    `src/scripts/benchmark-complex-live.ts`, `data/characteristics` output shape, or the
    worklist as-of cap (finding #1). Real TypeSafe/OpenAI SDK shapes are never exercised.

### 5. Concrete next steps (prioritized)

1. **Close the as-of leak**: call `assertAsOf(filter.asOf)` in `buildWorklist`
   (`src/givecampus/worklist.ts:165`) and tighten `parseWorklistFilter`'s upper bound to
   `AS_OF_DATE` (`src/givecampus/criterion.ts:93`); add a regression test.
2. **Stop the `data/characteristics` ID leak**: add `data/characteristics/` (or `data/*.json`
   outputs generally) to `.gitignore`, or write precompute output to a directory already ignored
   and strip `poolIds`/`verdictsByConstituent` from committed artifacts. (Not done in this
   review — out of scope per instructions.)
3. **Implement the advertised `priority_desc` sort** in `store.listCandidateConstituents`, and
   make `run-query.ts` scan by that ordering (or document that the scan is id-ordered).
4. **Unify field/action/criterion contracts**: one exported field list, one action enum, one
   rubric criterion type reused by `pipeline`, `benchmark`, and `characteristics`.
5. **Reconcile the 24-month vs 2-year vs 5-year windows** in the three Jev-state/item-card
   builders; pick canonical band definitions and name them accordingly.
6. **Fix the LLM comparator**: add a unit test that asserts `evaluateLlmRubricCandidate`
   extracts `tag:final_action` from a realistic Responses payload, then re-run
   `benchmark-complex-live` and confirm non-zero action accuracy before trusting the prompt tweak.
7. **Harden endpoints**: auth or localhost-only binding for `/api/query-jobs` and `/api/rubric`;
   drop `access-control-allow-origin: *` for non-GET.
8. **Wire the semantic pipeline into the product** (or explicitly scope it as benchmark-only):
   today the UI's `/api/worklists` → `buildWorklist` path never touches `retrieval/*` or
   `pipeline/*`, so the headline "semantic-first" capability is not reachable from the demo.
9. **Add npm scripts** for every runner and make `setup` idempotent (`ingest --force` or a guard).
10. **Regression tests** for the worklist as-of cap, `benchmark-complex-live` report shape, and
    `precompute-characteristics` output sanitization.
11. **Performance**: batch the item-card/elegibility reads or push band computation into SQL;
    the current N+1 card build will not scale past the hackathon dataset.
12. **Docs drift**: update `docs/BENCHMARK.md:149` and `docs/SEMANTIC_FIRST_PIPELINE_HANDOFF.md:30-33`
    to match git reality.

### 6. Task 2 — exact commands and results

Run on 2026-09-20 as part of this review:

```
> npx tsc --noEmit -p tsconfig.json
(no output)
exit code 0

> npx vitest run
Test Files  19 passed (19)
     Tests  144 passed (144)
  Duration  8.48s
exit code 0
```

Both are green, and were re-run immediately after `plan.md` was written (first run 8.82s,
second run 8.48s — identical 19 files / 144 tests). The suite was run against the working tree
as it stood at review time (including the uncommitted `final-decision.ts`,
`precompute-characteristics.ts`, `characteristics.test.ts`, and `llm-rubric-adapter.ts` edits).
A concurrent writer was observed touching files during the review.

### 7. Commit / push record

Recorded after the commit step (see git log for the authoritative hash).
