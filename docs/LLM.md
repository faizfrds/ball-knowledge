# LLM integration (isolated OpenAI module)

Scope: `src/llm/*` + `tests/llm*.test.ts` + this doc only. No edits to
`package.json`, server, engine (`src/givecampus/*`), web, or benchmarks.
Transport is Node 20 native `fetch`; tests inject `fetchFn` (no network, no key).

## The two bounded jobs

1. **Compile NL -> rubric** (`src/llm/rubric.ts:compileRubric`).
   Input: natural-language query + explicit `AvailableField[]` schema.
   Output: strict typed `CompiledRubric` (`filters: {field, op, value}[]`,
   `jevQuestions: <literal headline IDs>[]`).
   - Allowlisted fields: `city, state, affiliationType, lastGiftDate,
     giftCount24mo, lifetimeTotal, explicitRating, engagementEvents,
     title, employer` (a field must ALSO appear in the caller schema).
   - Allowlisted ops: `eq, neq, gte, lte, gt, lt, contains, in, between`.
   - Literal Jev questions only: `has_recent_gift, has_repeat_giving,
     title_employer_context_present, engagement_level,
     capacity_evidence_strength, permitted_action`
     (same IDs as `src/givecampus/jev.ts:HEADLINE_QUESTIONS`).
   - All output validated in code (`validateRubric`); executable fragments
     (`SELECT/WHERE/DROP/;--/...`) rejected. ANY failure -> safe default
     headline rubric (`DEFAULT_HEADLINE_RUBRIC`: no filters, all six
     questions) with `fallback: true`. One LLM call per compile, never per
     candidate. `title/employer` are weak context only.

2. **Explain top<=20** (`src/llm/explain.ts:explainRanked`).
   Input: final ranked items (`{id, evidenceRefs[], evidenceText[]}`).
   Output: one line (<=280 chars, no newlines) per item, each citing a
   caller-supplied evidence ref verbatim (e.g. `gifts:11`).
   - Single batched call for the whole list — never per candidate.
   - Code enforces `items.length <= 20` (throws; caller pages first) and
     non-empty `evidenceRefs` per item.
   - `validateReason` repairs: overlong/multiline, missing/invented refs,
     and banned claims (probability, expected/projected revenue,
     capacity-from-title, best-send-time, household, AI-verified, top-donor)
     become `Held for review — evidence: <refs>.` IDs and caller order are
     preserved; invented IDs ignored; gaps filled with the safe template.

## Transport (`src/llm/client.ts`)

- OpenAI Responses API (`POST https://api.openai.com/v1/responses`) with
  structured JSON output (`text.format.json_object`); tolerant parsing of
  `output_text` or `output[].content[].text`.
- Model: `OPENAI_MODEL`, default `gpt-5-mini`. Key: `OPENAI_API_KEY`,
  server-only (`ensureServer` throws in browsers); never logged.
- Timeout per attempt (`OPENAI_TIMEOUT_MS`, default 15000ms, AbortController);
  retries (`OPENAI_MAX_RETRIES`, default 2, exponential 500ms->5000ms +
  jitter, honors `Retry-After`, capped 60s) for transient 408/429/500-599 +
  network/timeout errors only. 400/401/403/404/422 fail fast.
- Telemetry per call: `model` echo, `inputTokens`, `outputTokens`,
  `latencyMs`, `retries`, estimated-cost fields. Pricing is NEVER hard-coded:
  `estimated*Usd` are `null` unless the operator sets explicit
  `OPENAI_INPUT_USD_PER_MTOK` / `OPENAI_OUTPUT_USD_PER_MTOK`.

## Live smoke (no committed credentials)

`src/llm/smoke.ts:runLlmSmoke` loads `.env.local` via `src/env.ts` (real env
wins), sends one minimal `{"ok": true}` structured call, and prints only
`{ok, model, inputTokens, outputTokens, latencyMs, retries}`:

```sh
npx tsx src/llm/smoke.ts
```

Never log the key or private inputs.

## Determinism / safety notes

- Deterministic gates stay in `src/givecampus/*` (eligibility, actions);
  the LLM never overrides exclusions and never sees per-candidate fan-out.
- Cache identity for any future caching must include dataset/evidence
  version, as-of date, full criterion hash, and model version (see Jev
  contract); weight edits rerank only.
- Banned copy (probabilities, expected revenue, title=>capacity, best time,
  households, unverified-model claims) is filtered in code, not by prompt.
