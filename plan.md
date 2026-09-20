# Ball Knowledge — Regeneron vertical: build log

Reconstructed from the current codebase, eval-run history, and README state
(no prior git history to draw on — this repo has one commit, "Create
README.md"; everything else below was built and evaluated directly against
the working tree). This is a record of what exists, why it's shaped the way
it is, and what was tried and discarded along the way.

## Goal

Match a free-text patient note against ~375k ClinicalTrials.gov records, and
benchmark trial designs against enrollment stats — without an LLM reading the
candidate pool trial-by-trial. Two general-purpose LLM calls bookend each
query (O(1) per query); everything that scales with pool size runs through
Jev (TypeSafe's System One model) instead.

## What was built

- **Patient → trials pipeline** (`ball_knowledge/pipeline/patient_to_trials.py`):
  extract → retrieve → gate → check criteria → label/rank/explain. See README
  for the full stage breakdown.
- **Design-benchmark pipeline** (`ball_knowledge/pipeline/design_benchmark.py`):
  same shape — one LLM call to parse the query into filters, code-side
  filtering, one Jev call per candidate for endpoint/population/design match,
  code computes enrollment stats.
- **Retrieval**: hybrid BM25 + OpenAI-embedding index combined via reciprocal
  rank fusion (`retrieval/index.py`), with a code-side prefilter
  (age/sex/recruiting, or phase/status/condition) applied *before* search.
- **Criteria handling**: eligibility text split into individual
  inclusion/exclusion criteria (`criteria/split.py`); numeric ones (age, lab
  thresholds) evaluated deterministically in code (`criteria/classify.py`);
  everything else goes to one Jev Choice call per criterion.
- **Cost receipt**: exact token counts and (where priced) dollar cost per
  run, split by stage (`cost_receipt.py`).
- **Enrichment subsystem** (`ball_knowledge/enrichment/`): a background
  crawler that compiles a free-text rubric prompt into Jev Noul "yes/no"
  columns, runs them in batch across a trial database, and persists results
  in an append-only column store (`columns.json` + `values.jsonl.gz`) so
  reruns only fill in new columns. Built as a standalone capability, driven
  via the CLI `enrich` subcommand — separate from the two demo pipelines.
- **Deterministic explanation path** (`criteria/rubric_explain.py`): formats
  an audit-ready explanation directly from Jev verdicts and code evaluations,
  bypassing the secondary LLM explanation call entirely. Exists alongside
  (not instead of) the LLM-written top-10 explanations in the main pipeline.
- **Eval harness** (`ball_knowledge/eval/`): NDCG@10 + eligible/excluded
  accuracy against TREC-CT 2021/2022/2023 qrels, across four baseline
  systems: `bm25`, `hybrid`, `hybrid_rerank` (Cohere, optional), `llm_only`,
  plus the full `ball_knowledge` system.
- **FastAPI + static-HTML demo UI** (`app/`) and CLI (`ball_knowledge/cli.py`)
  for both pipelines.

## Decisions, and what didn't work

### Retrieval: hybrid BM25 + embeddings, not BM25 straight into Jev

The straightforward version of this pipeline would be: BM25 over the full
corpus for the top-k, then send that pool straight to the Jev gate — no
embedding stage at all. That's cheaper to build and skips an entire index
(and its embedding-API cost) up front.

That's not what shipped. `retrieval/index.py` runs BM25 and an
OpenAI-embedding cosine ranking in parallel and combines them with
reciprocal rank fusion (RRF), before anything reaches the gate. Reasoning
documented in the module docstring: RRF needs no score normalization between
two very differently scaled signals, which is the standard reason to prefer
it over either signal alone.

The eval history backs this up, though not uniformly:

| Run | Topics | BM25 NDCG@10 | Hybrid NDCG@10 |
|---|---|---|---|
| `run_20260920_042533_hybrid` (2021) | 75 | 0.215 | **0.303** |
| `run_2022` | 50 | 0.209 | **0.284** |
| `run_2023` | 40 | **0.350** | 0.330 |
| `run_2023_updated` | 40 | **0.350** | 0.330 |

Hybrid clearly wins on the 2021 and 2022 topic sets (+0.07–0.09 NDCG@10).
On 2023 it's actually slightly *behind* BM25 alone (0.330 vs 0.350) — worth
flagging rather than papering over. The 2021 set is the primary evaluation
set (largest topic count, matches the corpus snapshot year), and hybrid is
the default there; the 2023 result suggests BM25-only may be competitive or
better for some topic distributions and is worth another look before
assuming hybrid is strictly better everywhere.

Net: embeddings were kept in the retrieval stage rather than skipped, but
the win isn't universal across topic years — this is a "mostly validated,
not fully closed" decision, not a clean-cut win.

### Numeric criteria: code first, Jev fallback — never forced

`criteria/classify.py` deliberately does *not* try to make code handle every
numeric-looking criterion. Age/lab-threshold phrasings it's confident about
are evaluated in code; anything relative (e.g. "ALT ≤ 2.5 × ULN" — a
multiplier of a lab's own upper limit of normal, not a comparable absolute
value) falls through to Jev by design. The stated reasoning: a wrong code
judgment is worse than a fall-through, so uncertain cases are deliberately
not force-fit into a regex.

### `not_stated` is a first-class Jev verdict, not a default

The per-criterion Jev Choice call has three outcomes: `meets` /
`does_not_meet` / `not_stated`. This was a deliberate design choice
(documented in the README's stage table) to avoid silently forcing a
criterion the patient note doesn't address into either meets or
does-not-meet — a numeric-style criterion with no code-recognized pattern,
or a fact the note is simply silent on, has to be representable as "unknown"
rather than guessed.

### `run_eval.py`'s recruiting-status default diverges from production, on purpose

Production (app/CLI) defaults `require_recruiting=True` — a real coordinator
wants only trials a patient could actually enroll in today. The eval harness
defaults `require_recruiting=False` instead, because TREC-CT-2021's ground
truth judges eligibility-criteria match, not current recruitment status, and
most of that 2021 snapshot's "eligible" trials are long since `Completed` —
applying the production filter would silently exclude ~98% of the
benchmark's own ground truth and make the eval meaningless. `--bk-require-recruiting`
exists to opt back into the production behavior when that's what's being
measured.

### LLM-only baseline: kept as a comparison point, not shipped as the real path

`llm_client.py` implements an `llm_only` baseline — one big LLM call per
trial, same rubric, no Jev — purely so the eval table has a "what if we just
threw a frontier LLM at every trial" row to compare against. From
`run_20260920_042533`: `llm_only` costs ~$4.13/query and ~236s median
latency on a 1000-candidate slice (scaled), versus `ball_knowledge`'s
Jev-based pipeline over the *full* pool at ~47s median latency and, now that
Jev's published rate ($0.042/million input tokens, output free) is set in
`.env`, ~$0.14/query recomputed from that run's recorded token counts
(~1.07M Jev input tokens/query × $0.042/M ≈ $0.045, plus ~$0.095 of OpenAI
cost for the two O(1) calls) — roughly **30x cheaper** than `llm_only` at
comparable NDCG@10 (0.330 vs 0.345) and ~5x lower latency. This is the
concrete evidence for the repo's core thesis — Jev instead of LLM-per-trial —
rather than an assumption.

### Deterministic explanations built as an alternative path, not a replacement

`criteria/rubric_explain.py` produces an audit-ready explanation directly
from Jev verdicts/code evaluations with no LLM call at all. It sits alongside
the LLM-written top-10 explanations (`explain_top_trials`) rather than
replacing them — the LLM explanation is still what a coordinator reads by
default; the deterministic path is available where a fully auditable,
LLM-free explanation trail matters more than natural-language quality.

## Current eval snapshot

| System | Topics (2021) | NDCG@10 | Eligible/Excluded Acc. | $/query | Median latency |
|---|---|---|---|---|---|
| `bm25` | 75 | 0.215 | — | $0.00 | 5.4s |
| `hybrid` | 75 | 0.303 | — | $0.00 | 5.9s |
| `llm_only` (scaled) | 69 | 0.345 | 0.697 | $4.13 | 236s |
| `ball_knowledge` | 75 | 0.330 | 0.576 | ~$0.14* | 47s |

\* Recomputed from `run_20260920_042533`'s recorded per-query token counts
now that Jev's rate ($0.042/million input tokens, output free) is known —
the run itself predates setting `TYPESAFE_INPUT_PRICE_PER_MTOK`, so its
`summary.json` still shows `cost_usd_per_query: null`. A fresh eval run will
populate this field directly.

Eligible/excluded accuracy is lower for `ball_knowledge` (0.576) than
`llm_only` (0.697) in this run — an open gap, not yet closed. NDCG@10 is
close between the two (0.330 vs 0.345) despite `ball_knowledge` running over
the entire retrieval pool rather than a 1000-candidate slice, at roughly
5x lower latency and without per-trial LLM cost scaling.

## Known limitations (carried from README, restated with cause)

- Numeric-criteria parser intentionally incomplete — see "Numeric criteria" above.
- Jev token counts are exact; dollar cost now resolves via
  `TYPESAFE_INPUT_PRICE_PER_MTOK` (defaults to Jev's published $0.042/million
  input tokens, output free) — set in `.env` as of this session, so historical
  eval runs before that (e.g. `run_20260920_042533`) still show
  `cost_usd_per_query: null` in their saved `summary.json` and need a rerun
  to get it baked in.
- Eligible/excluded accuracy trails the (far more expensive) `llm_only`
  baseline — not yet investigated further.
- Hybrid retrieval's advantage over BM25-only isn't consistent across TREC
  years (see table above) — worth a follow-up eval pass before treating
  hybrid as the settled default for every topic distribution.
- GiveCampus and Dropbox verticals from the broader Ball Knowledge design are
  out of scope for this repo.

## Not yet done / open threads

- Investigate the `ball_knowledge` vs `llm_only` eligible/excluded accuracy
  gap (0.576 vs 0.697) — is it the gate threshold, criterion-splitting
  quality, or the `not_stated` handling being conservative?
- Re-run the BM25-vs-hybrid comparison on the 2023 topic set with more
  topics to see if BM25-only's edge there is real or noise (n=40 is small).
- `hybrid_rerank` (Cohere) baseline exists in `eval/baselines.py` but no run
  in `eval_results/` currently includes it — not yet benchmarked.
- Rerun `run_eval.py` now that `TYPESAFE_INPUT_PRICE_PER_MTOK` is set, so
  `summary.json`/`results_table.md` report real `$/query` for
  `ball_knowledge` directly instead of the hand-computed estimate above.
