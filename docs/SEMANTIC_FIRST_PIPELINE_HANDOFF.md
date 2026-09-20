# Semantic-First Ball Knowledge: Implementation and Benchmark Handoff

## Purpose

This document captures all remaining work required to turn the current GiveCampus prototype into the intended Ball Knowledge pipeline:

```text
plain-English query
  -> route
  -> compile a complete typed rubric
  -> apply deterministic filters
  -> hybrid BM25 + embedding retrieval
  -> Jev gates
  -> Jev scores, bonuses, and tags
  -> code ranking
  -> LLM explanations for only the top 20
```

It also specifies a harder, fair benchmark comparing:

1. semantic retrieval alone;
2. semantic retrieval plus Jev rubric evaluation;
3. semantic retrieval plus an LLM evaluating the same rubric and item cards.

The benchmark must report quality, token use, cost, latency, cache behavior, and candidate-pool recall.

## Repository State

- Branch: `feat/givecampus-worklist`
- Reference data remains intentionally untracked:
  - `20260919_GiveCampus_MIT_Hackathon-20260920T063012Z-1-001/`
  - `20260919_GiveCampus_MIT_Hackathon-20260920T063012Z-1-001.zip`
- Generated benchmark caches remain intentionally untracked under `data/benchmark/`.
- No partial source changes were left by the stopped implementation wave.

Important completed commits:

| Commit | Purpose |
|---|---|
| `9a5528a` | TypeScript, SQLite, ingestion, and deterministic feature foundation |
| `67868e4` | GiveCampus eligibility, actions, scoring, Jev client, caching, and worklist jobs |
| `0e26440` | Responsive Giving Day triage UI |
| `0edfebd` | Bounded OpenAI rubric compiler and top-20 explainer |
| `c1fc95f` | Structured-data ranking benchmark |
| `39efbc9` | Bounded live Jev candidate-pool benchmark |
| `4a854a8` | Final API/UI/LLM integration and frozen experimental ranker |
| `7e0bdf3` | Ingestion and storage hardening |
| `15bc720` | Full-population semantic versus semantic-plus-Jev benchmark |

## What Exists Today

### Implemented

- SQLite ingestion for all 15 GiveCampus tables.
- Deterministic eligibility and action restrictions.
- As-of-safe feature calculations and evidence references.
- A fixed, development-selected logistic ordering.
- A server-only TypeSafe/Jev client with telemetry and a process-local cache.
- A server-only OpenAI rubric endpoint.
- A single batched OpenAI explanation call over at most 20 final results.
- Background-like worklist jobs with polling.
- Responsive triage-board UI.
- Full-population embedding benchmark and a bounded Jev rerank benchmark.

### Missing or Incomplete

| Pipeline stage | Current gap |
|---|---|
| Router | No lookup/simple/deep/analysis classifier in the product path |
| Full rubric | Compiler returns filters plus a subset of six fixed question IDs, not dynamic phrasings/gates/scores/bonuses/tags/weights |
| Semantic retrieval | Exists only in a benchmark script, not `buildWorklist` |
| BM25 | Not implemented in the product |
| Retrieval fusion | No reciprocal-rank fusion of BM25 and embeddings |
| Rubric pilot | No top-50 pilot or validation pass |
| Jev gates | Fixed questions run only when explicitly enabled and do not filter the worklist |
| Jev scoring | Jev answers do not determine final rank |
| Dynamic categories | LLM does not create the actual criteria Jev evaluates |
| Granular cache | Cache stores a complete Jev call in memory, not persistent per-item/per-question answers |
| Editable reruns | Editing one UI criterion does not rerun only that criterion |
| Analysis mode | No Choice tagging, code aggregation, and LLM summary path |
| Streaming | UI polls; no persistent job state or SSE result stream |

Critical current references:

- Limited rubric shape: `src/llm/rubric.ts`
- Fixed Jev questions: `src/givecampus/jev.ts`
- Current worklist orchestration: `src/givecampus/worklist.ts`
- Frozen ordering: `src/givecampus/frozen-lr.ts`
- Jobs and final explanations: `src/givecampus/jobs.ts`
- API endpoints: `src/server.ts`
- Existing semantic experiment: `src/scripts/benchmark-semantic-jev.ts`

## Non-Negotiable Design Rules

1. The LLM never reads the candidate pile.
2. The LLM may compile one rubric and explain at most the final 20.
3. Deterministic restrictions run before retrieval or model judgment.
4. Numbers, dates, counts, and exact comparisons run in code.
5. Jev questions are literal, positive, and contain one judgment.
6. Each Jev question receives only its listed fields.
7. Missing evidence maps to `unknown` or `review_needed`, never an invented negative.
8. Eligibility, priority, evidence completeness, and review state remain separate.
9. Scores are ordinal ranking signals, not donation probabilities.
10. Title and employer are weak context, not verified giving capacity.
11. Every displayed reason links to source evidence.
12. Every API receipt states dataset version, as-of date, rubric version, model versions, tokens, cost, latency, and cache use.

## Target Rubric Contract

Add a canonical rubric contract, preferably in `src/pipeline/rubric.ts`.

```ts
type FieldName =
  | "city"
  | "state"
  | "affiliation_type"
  | "class_year"
  | "gift_recency_band"
  | "gift_frequency_band"
  | "giving_amount_band"
  | "engagement_events"
  | "interaction_summary"
  | "career_change_band"
  | "title"
  | "employer"
  | "contactability"
  | "solicitation_fatigue_band";

interface TypedFilter {
  field: FieldName;
  op: "eq" | "neq" | "gte" | "lte" | "gt" | "lt" | "contains" | "in" | "between";
  value: string | number | boolean | null | Array<string | number>;
}

interface GateCriterion {
  id: string;
  question: string;
  trueCriteria: string;
  falseCriteria: string;
  fields: FieldName[];
  threshold: number;
  unknownPolicy: "review" | "downrank" | "exclude";
}

interface ScoreCriterion {
  id: string;
  question: string;
  levels: [string, string, ...string[]];
  fields: FieldName[];
  weight: number;
}

interface BonusCriterion {
  id: string;
  question: string;
  trueCriteria: string;
  falseCriteria: string;
  fields: FieldName[];
  weight: number;
}

interface TagCriterion {
  id: string;
  question: string;
  options: Record<string, string>;
  fields: FieldName[];
}

interface CompiledRubric {
  id: string;
  version: string;
  route: "lookup" | "simple" | "deep" | "analysis";
  filters: TypedFilter[];
  phrasings: string[];
  gates: GateCriterion[];
  scores: ScoreCriterion[];
  bonuses: BonusCriterion[];
  tags: TagCriterion[];
}
```

### Validation

- Maximum 12 filters.
- Two to five retrieval phrasings.
- Maximum six gates, six scores, four bonuses, and four tags.
- Score criteria have two to four ordered levels.
- Choice criteria have at most 12 options for this prototype.
- Weights are finite, non-negative, and normalized in code.
- Field names come from a dataset-specific allowlist.
- No raw SQL or executable filter strings.
- Reject Jev questions containing direct numerical/date comparison instructions.
- Reject negative questions such as "Is this person not engaged?".
- Preserve the current safe fallback rubric.

### Compiler Changes

Modify:

- `src/llm/rubric.ts`
- `src/llm/index.ts`
- `tests/llm.test.ts`

Add:

- `src/pipeline/rubric.ts`
- `tests/pipeline-rubric.test.ts`

Keep a compatibility adapter until the current `/api/rubric` and tests migrate.

## Query Router

Add `src/pipeline/router.ts`.

Output:

```ts
interface RouteDecision {
  route: "lookup" | "simple" | "deep" | "analysis";
  confidence: number;
  wantsAll: boolean;
  hasNumber: boolean;
  reason: string;
}
```

Behavior:

- Use one small injectable Jev request for route classification.
- Provide a deterministic fallback for missing credentials.
- Move low-confidence decisions one level deeper.
- Start raw-query semantic retrieval concurrently with routing.
- Lookup and simple paths should avoid OpenAI rubric compilation.
- Deep and analysis paths compile the complete rubric.

Tests:

- direct ID/name lookup;
- simple keyword query;
- multi-constraint deep query;
- group-summary analysis query;
- low-confidence escalation;
- number and wants-all flags.

## Item Cards

Add `src/retrieval/item-card.ts`.

Each card must be as-of-safe and contain code-derived bands rather than asking Jev to calculate:

```ts
interface ConstituentCard {
  constituentId: number;
  asOf: string;
  searchText: string;
  fields: {
    gift_recency_band?: string;
    gift_frequency_band?: string;
    giving_amount_band?: string;
    engagement_events?: string[];
    interaction_summary?: string[];
    career_change_band?: string;
    title?: string;
    employer?: string;
    city?: string;
    state?: string;
    affiliation_type?: string[];
    class_year?: number;
    contactability?: string;
    solicitation_fatigue_band?: string;
  };
  evidenceRefs: Record<string, string[]>;
}
```

Requirements:

- A separate formatter selects only fields required by each Jev question.
- Search cards may contain all non-sensitive retrieval text.
- Question states contain only `criterion.fields`.
- Item-card hashes include dataset/evidence version and as-of date.
- Never log names, email addresses, phone numbers, or raw notes.

## Hybrid Retrieval

Add:

- `src/retrieval/bm25.ts`
- `src/retrieval/embeddings.ts`
- `src/retrieval/embedding-cache.ts`
- `src/retrieval/rrf.ts`
- `src/retrieval/retrieve.ts`

### Retrieval Sequence

1. Apply deterministic eligibility and typed filters.
2. Build/reuse item cards for surviving constituents.
3. Run BM25 independently for every rubric phrasing.
4. Embed every phrasing and run cosine search.
5. Fuse rankings with reciprocal-rank fusion.
6. Keep a configurable candidate cap.
7. If survivors are fewer than the cap, judge all survivors.

Recommended initial defaults:

```text
candidate cap: 2,000 for interactive runs
maximum supported cap: 20,000
RRF k: 60
BM25 contribution: one rank list per phrasing
embedding contribution: one rank list per phrasing
```

Do not hard-code semantic similarity into final judgment. It is a retrieval signal and final tiebreaker, not the primary rubric score.

### Embedding Cache

Use a separate SQLite cache, for example `data/retrieval-cache.sqlite`.

```sql
CREATE TABLE embedding_cache (
  cache_key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  input_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
```

Cache key:

```text
dataset_version
+ evidence_version
+ as_of
+ item_card_hash
+ embedding_model
```

Add mockable native-fetch support for `text-embedding-3-small` and record:

- input tokens;
- batch count;
- live/cache counts;
- p50/p95 request latency;
- estimated cost;
- embedding model.

## Dynamic Jev Evaluator

Add:

- `src/pipeline/jev-evaluator.ts`
- `src/pipeline/question-cache.ts`
- `src/pipeline/rank.ts`

### Gate Stage

For each retrieved candidate:

1. Build one field-scoped state per gate.
2. Ask a Noul using the compiled true/false criteria.
3. Convert the answer into `pass`, `fail`, or `unknown` using the gate threshold.
4. Apply the configured unknown policy.
5. Preserve every raw answer and evidence reference.

Do not multiply gate probabilities. A candidate must satisfy each required criterion or enter review according to policy.

### Score Stage

Only gate survivors receive:

- dynamic Score questions;
- bonus Nouls;
- Choice tags.

Normalize a Score with `n` levels as:

```text
normalized_score = raw_score / (n - 1)
```

Unknown criteria are removed from numerator and denominator; they reduce evidence completeness and may force review.

Suggested rank calculation:

```text
rubric_score =
  weighted_mean(known normalized scores)
  + sum(bonus_weight * bonus_probability)

final_rank =
  rubric_score
  + 0.10 * predictive_prior
  + 0.02 * retrieval_tiebreaker
```

The predictive prior is optional and applies only to queries explicitly asking about future giving. It must never override eligibility or a failed gate.

### Jev Request Shape

- One constituent per request.
- Include all applicable questions whose field scopes can safely share that constituent state.
- Do not pack unrelated constituents into one shared state until measured stability supports it.
- Use bounded concurrency and TypeSafe retry behavior.
- Log resolved model, tokens, request latency, retry count, and cache status.

## Persistent Per-Question Cache

The current `MemoryCache` is insufficient for editable rubrics.

Use a SQLite table such as:

```sql
CREATE TABLE question_answers (
  cache_key TEXT PRIMARY KEY,
  constituent_id INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  relevant_state_hash TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  as_of TEXT NOT NULL,
  model TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0
);
```

Cache key includes:

```text
constituent_id
+ complete question text and criteria
+ only the fields relevant to that question
+ dataset/evidence version
+ as-of date
+ model version
```

Expected behavior:

- weight edit: rerank only;
- threshold edit: re-evaluate cached answer in code;
- question text/criteria edit: rerun only that question;
- filter/retrieval edit: evaluate only newly introduced candidates;
- evidence change: invalidate only affected constituent/question states.

## Pilot and Revision

Before judging the full pool:

1. Run gates on the top 50 retrieved candidates.
2. Report gate distributions and unknown rates.
3. Revise once only when:
   - the rubric references unsupported fields;
   - questions violate Jev-writing rules;
   - unknown rates indicate missing required evidence;
   - the rubric is internally contradictory.

Do not revise only because zero or more than 40% pass; the query may genuinely have that distribution.

## Product Orchestration

Create a new orchestrator rather than continuing to overload `buildWorklist`:

- `src/pipeline/run-query.ts`
- `src/pipeline/types.ts`

Suggested stages:

```text
queued
route
compile
filter
retrieve_bm25
retrieve_embeddings
fuse
pilot
gate
score
rank
explain
complete
```

`buildWorklist` can remain as the legacy fixed GiveCampus path until the new orchestrator passes integration tests.

### API

Add or migrate to:

```text
POST /api/query-jobs
GET  /api/query-jobs/:id
GET  /api/query-jobs/:id/events
PATCH /api/query-jobs/:id/rubric
POST /api/query-jobs/:id/cancel
```

`POST /api/query-jobs` request:

```json
{
  "query": "...",
  "asOf": "2026-08-31",
  "candidateCap": 2000,
  "explainTop": true
}
```

Response/result must include:

- route decision;
- compiled rubric;
- filter counts;
- retrieval pool size and per-source ranks;
- gate distributions;
- score/tag outputs;
- final ranked rows;
- exclusions/review queue;
- complete cost receipt.

Persist jobs and progress in SQLite. Add SSE for provisional rows, but retain polling fallback.

## UI Changes

Modify:

- `web/js/api.js`
- `web/js/app.js`
- `web/index.html`
- `web/styles.css`

Required UI behavior:

- Display current route and why it was selected.
- Display retrieval phrasings.
- Show BM25, semantic, and fused candidate counts.
- Render dynamic gates, scores, bonuses, tags, fields, thresholds, and weights.
- Make weights editable without new Jev calls.
- Make a single question editable and show only that criterion rescoring.
- Show provisional results while gates/scores run.
- Separate failed gates, unknown/review, and eligible results.
- Show source evidence and missing fields per answer.
- Show token/cost/latency receipts by stage and provider.
- Never label an ordinal model score as probability.

## Analysis Mode

For `route = analysis`:

1. Retrieve and gate candidates normally.
2. Run compiled Choice tags over survivors.
3. Count tag values in code.
4. Select five representative examples per major category.
5. Send only counts and examples to the LLM.
6. Return the summary plus raw counts and evidence.

## Complex Comparative Benchmark

The existing benchmark query is too broad. Add a multi-query benchmark where semantic similarity is insufficient because relevance depends on conjunctions, exclusions, and action judgment.

### Shared Protocol

- Development cutoff: `2024-08-31`.
- Locked test cutoff: `2025-08-31`.
- All evidence must be available by the cutoff.
- Identical deterministic eligibility and candidate pools across systems.
- Gold labels are generated from hidden structured conditions, then audited on a stratified sample.
- Models receive text item cards, not the hidden label expression.
- Numeric/date facts appear as code-derived bands.
- No system may use opportunity outcomes or future records.

### Query 1: Lapsed Loyal, Still Engaged, Ready for Personal Outreach

Natural-language query:

> Find previously loyal donors who have not given recently but remain meaningfully connected through events, volunteering, or responsive interactions, show a recent career-development signal, are reachable, and have not been solicited recently. Recommend personal outreach versus a broad invitation.

Hidden gold conditions:

- eligible and reachable;
- at least three paid gifts before the cutoff;
- no paid gift in the prior three years;
- at least one event, activity, volunteer record, or connected interaction in the prior two years;
- career row recorded in the prior 180 days, or explicit strong engagement when career evidence is absent;
- no solicitation interaction in the prior 30 days;
- no open pledged/meeting-booked follow-up collision.

Graded relevance:

```text
3 = satisfies all conditions and personal outreach is permitted
2 = satisfies loyalty + lapse + engagement but career signal is absent/unknown
1 = semantically similar but fails one important readiness condition
0 = ineligible, recently solicited, not lapsed, or no ongoing connection
```

Action gold:

```text
personal_outreach
broad_invite
hold_for_review
exclude
```

### Query 2: Stewardship Before Another Ask

> Find constituents who recently made a meaningful gift, have not received a recorded acknowledgement, remain contactable, and should receive a thank-you rather than another solicitation.

This query tests negation-like logic through positive Jev questions plus code inversion, evidence completeness, and action classification.

### Query 3: Reunion Re-Engagement

> Find lapsed alumni approaching a reunion year who still show non-giving affinity and should receive a reunion invitation rather than a direct ask.

This query tests structured date filters, semantic affinity, and action Choice.

### Query 4: Upgrade-Ask Review Queue

> Find consistent donors with increasing engagement and evidence supporting a more personal conversation, but flag cases where the suggested ask would be a stretch or important capacity evidence is missing.

This tests graded judgment and explicit `review_needed` handling without presenting capacity as verified wealth.

## Systems to Compare

All systems start from the same filtered population and the same semantic/BM25 candidate pool.

### A. Semantic Only

- Rank by fused BM25 + embedding retrieval.
- No rubric judgment.

### B. Semantic + Jev

- Same candidate pool.
- Jev evaluates compiled gates, scores, bonuses, and Choice action.
- Code computes final rank.

### C. Semantic + LLM

- Same candidate pool.
- OpenAI evaluates the exact same rubric and exact same item-card fields.
- Use strict structured output matching Jev answer types.
- Do not let the LLM read the entire pool in one prompt.
- Batch only when the same isolation rules remain true.

### D. Code Oracle / Gold Expression

- Use hidden structured conditions directly.
- This is an upper-bound/reference, not a deployable semantic system.

### E. Current Frozen Ranker

- Include as a GiveCampus-specific baseline.

## LLM Comparator

Add an adapter, preferably:

- `src/benchmark/llm-rubric-adapter.ts`

Requirements:

- Same question wording and criteria as Jev.
- Same field-scoped state.
- Structured outputs for Noul, Score, and Choice.
- One candidate at a time or safely isolated batches.
- Configurable model; default `gpt-5-mini` for cost comparison.
- Record resolved model, prompt-cached tokens, input/output/reasoning tokens, retries, and latency.
- Cache responses by the same identity used for Jev plus provider/model.

Also report a separate extrapolated LLM-all-items cost based on measured per-item usage. Label it a projection.

## Benchmark Metrics

### Retrieval

- Recall@100, @500, @2,000.
- Relevant items lost before Jev/LLM evaluation.
- BM25-only, embedding-only, and fused recall.

### Ranking

- NDCG@10 and @20 using graded labels.
- Precision@20.
- Recall@20.
- Mean reciprocal rank.

### Rubric Quality

- Gate accuracy and F1 per gate.
- Unknown/review rate.
- Score-level mean absolute error.
- Action Choice accuracy and macro F1.
- Forbidden-action override count.

### Cost and Performance

For each system and stage:

- candidates evaluated;
- requests;
- cache hits/misses;
- input tokens;
- cached input tokens;
- output/reasoning tokens;
- measured dollars;
- p50/p95 request latency;
- end-to-end latency;
- time to first provisional result;
- retries/errors.

Report cold-cache and warm-cache runs separately.

## Benchmark Fairness Rules

1. Define all queries and gold labels before viewing test results.
2. Tune thresholds only on development data.
3. Freeze prompts, models, weights, and candidate caps before the test run.
4. Do not pick a query solely because Jev wins it.
5. Publish every query result, including losses.
6. Use identical candidate pools and item-card fields for Jev and LLM.
7. Report hit counts with precision because top-20 differences are discrete and noisy.
8. Include confidence intervals or paired bootstrap/permutation intervals across queries.
9. Keep future-gift prediction separate from rubric/action judgment.
10. Do not describe observational gift outcomes as causal fundraising lift.

## Expected Benchmark Output

Produce:

- `docs/results/complex-benchmark.json`
- `docs/results/complex-benchmark.md`

Example summary table:

| System | Retrieval Recall@2k | NDCG@20 | P@20 | Gate F1 | Action Accuracy | Input Tokens | Output Tokens | Cost | p50 | p95 | End-to-End |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Semantic | | | | n/a | n/a | | | | | | |
| Semantic + Jev | | | | | | | | | | | |
| Semantic + LLM | | | | | | | | | | | |
| Frozen ranker | | | | n/a | | | | | | | |
| Code oracle | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 0 | 0 | 0 | | | |

## Existing Results to Preserve

### Structured Ranking Benchmark

- Held-out eligible population: 14,052.
- Future donors: 601.
- Development-selected logistic: 3/20, P@20 0.15, NDCG@20 0.194.
- Lexicographic RFM: 2/20, P@20 0.10, NDCG@20 0.095.
- Differences are descriptive and not statistically decisive.

### Semantic vs Semantic + Jev

From `docs/results/semantic-jev-2025-08-31.md`:

| System | Hits@20 | P@20 | NDCG@20 | Hits@100 | P@100 | NDCG@100 |
|---|---:|---:|---:|---:|---:|---:|
| Semantic cosine | 3 | 0.15 | 0.1024 | 15 | 0.15 | 0.1318 |
| Semantic + Jev | 2 | 0.10 | 0.1260 | 15 | 0.15 | 0.1497 |

Telemetry:

- Embeddings: 1,065,726 input tokens, $0.021315, 141 batches.
- Jev top-50 rerank: 56,866 input tokens, $0.002388, 48 live calls and 2 cache hits.

This result does not demonstrate a top-20 precision lift. The complex benchmark must be run without changing queries after observing outcomes.

## Implementation Order

### Phase 1: Contracts

- [ ] Add canonical full rubric types and validation.
- [ ] Expand OpenAI compiler output.
- [ ] Add router and route tests.
- [ ] Commit checkpoint.

### Phase 2: Retrieval

- [ ] Add item-card formatter.
- [ ] Add BM25.
- [ ] Add embedding client/cache.
- [ ] Add RRF fusion and candidate policy.
- [ ] Add retrieval recall tests.
- [ ] Commit checkpoint.

### Phase 3: Dynamic Jev

- [ ] Add dynamic question builders.
- [ ] Add field-scoped item state.
- [ ] Add persistent per-question cache.
- [ ] Add gate/score/bonus/tag evaluator.
- [ ] Add rubric-driven ranking.
- [ ] Commit checkpoint.

### Phase 4: Orchestration

- [ ] Add query-job orchestrator and persistent job state.
- [ ] Connect route, compile, filters, retrieval, Jev, rank, explain.
- [ ] Add receipts and progress events.
- [ ] Keep polling fallback.
- [ ] Commit checkpoint.

### Phase 5: UI

- [ ] Render actual generated rubric.
- [ ] Render retrieval progress and fused pool statistics.
- [ ] Support weight-only reranking.
- [ ] Support per-question rescoring.
- [ ] Render tags, unknowns, evidence, and receipts.
- [ ] Commit checkpoint.

### Phase 6: Complex Benchmark

- [ ] Freeze query/gold specification.
- [ ] Generate development and test fixtures.
- [ ] Implement semantic baseline.
- [ ] Implement Jev evaluator adapter.
- [ ] Implement LLM rubric adapter.
- [ ] Run cold-cache benchmark.
- [ ] Run warm-cache benchmark.
- [ ] Produce sanitized JSON and Markdown results.
- [ ] Commit checkpoint.

### Phase 7: Review

- [ ] Verify credentials never enter browser payloads or Git.
- [ ] Verify as-of leakage guards.
- [ ] Verify candidate-pool equality across systems.
- [ ] Verify token and cost receipts against raw API usage.
- [ ] Verify every explanation is evidence-bound.
- [ ] Run independent code and benchmark review.

## Acceptance Criteria

The work is complete when:

1. A plain-English deep query produces a full validated rubric.
2. BM25 and embeddings retrieve and fuse candidates from the eligible population.
3. Jev evaluates generated gates and scores, not six fixed questions.
4. Final ranking changes when rubric criteria or weights change.
5. A weight edit causes zero new Jev calls.
6. A single-question edit reruns only that question.
7. The LLM sees only the query/schema at compile time and the final top 20 at explanation time.
8. Analysis mode returns code-counted Choice categories plus an LLM summary.
9. The complex benchmark compares identical semantic pools with Jev and LLM.
10. Benchmark output reports quality, tokens, cost, p50/p95 latency, end-to-end time, and cache behavior.
11. No benchmark claims a Jev win unless the frozen multi-query results support it.
12. All secrets, model caches, embeddings, and raw PII remain uncommitted.

## Suggested Verification Commands

```powershell
npm install
npm run ingest
npm run typecheck
npm test
npm run build
npm run dev
```

Add scripts when implementation lands:

```text
npm run benchmark:complex
npm run benchmark:complex:warm
npm run pipeline:smoke
```

## Final Product Claim

Use only after the target pipeline and benchmark are complete:

> The LLM writes the rubric, semantic search finds the candidate pool, Jev applies the rubric to the candidates, code ranks and counts, and the LLM explains only the final shortlist.

The current repository is not yet entitled to that complete claim because semantic retrieval and dynamic rubric-driven Jev evaluation remain benchmark-only or disconnected from the product path.
