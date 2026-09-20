# Ball Knowledge — Regeneron vertical

Clinical trial matching and design benchmarking that treats eligibility as a
rubric a machine can run, instead of an LLM reading trial after trial.

This repo implements the **Regeneron / clinical trials** vertical of the
larger Ball Knowledge idea: answer hard questions over a huge pile of items
(here, ~375k `ClinicalTrials.gov` records) without an LLM ever reading the
pile. Two general-purpose LLM calls bookend each query; everything that scales
with the number of candidate trials runs through
[Jev](https://typesafe.ai) (TypeSafe's System One model) instead.

## What it does

1. **Patient → trials.** Give it a free-text patient note. It extracts
   structured facts, retrieves candidate trials, gates them on whether they
   even study the patient's condition, checks every eligibility criterion
   individually, and returns each trial labeled `eligible` / `excluded` /
   `not_relevant`, ranked, with a criterion-by-criterion explanation for the
   top 10.
2. **Design benchmarking.** Give it a free-text trial-design spec (e.g.
   *"completed phase 3 trials in moderate-to-severe atopic dermatitis, with a
   placebo arm and an EASI-75 endpoint"*). It filters on phase/status/
   condition, judges endpoint/population/design match, and reports enrollment
   statistics (min/max/median/quartiles) across the matched trials — a
   sample-size planning aid for biostatisticians.

Both demos are reachable from a small web UI (`app/`) as well as the CLI.
Every run produces a **cost receipt**: exact token counts and (where pricing
is configured) dollar cost for every LLM and Jev call, split out by stage.

This is a **screening aid for trial coordinators**, not a diagnostic or
enrollment tool — a clinician makes every final call.

## Why split the work this way

| Concern | Handled by | Why |
|---|---|---|
| Numeric criteria (age, labs) | Code | Deterministic, and an LLM is unreliable at exact numeric comparisons — regex-parsed bounds checked directly against extracted patient values. |
| "Does this trial study the patient's condition?" | Jev Noul (the **gate**) | A single yes/no judgment per retrieved trial, run over the whole retrieval pool before anything more expensive happens. |
| Individual eligibility criteria | Jev Choice (**meets / does_not_meet / not_stated**) | Only for the trials that pass the gate. `not_stated` is a first-class option — a numeric-style criterion with no code-recognized pattern, or a fact the patient note simply doesn't mention, must never be silently forced into meets/does-not-meet. |
| Structured extraction from the patient note | One OpenAI call | Runs once per query, not once per trial. |
| Top-10 explanations | One OpenAI call | Also O(1) per query — Jev returns no free-text reasoning, so the LLM writes the human-readable "why" only for what a coordinator will actually read. |

Everything that would otherwise scale with pool size (the gate, the
per-criterion checks) goes through Jev; everything else is a fixed, small
number of LLM calls per query. See `ball_knowledge/typesafe_client.py` and
`ball_knowledge/llm_client.py` for exactly where that line is drawn.

## Pipeline (patient → trials)

Implemented in `ball_knowledge/pipeline/patient_to_trials.py`:

1. **Extract.** One OpenAI call turns the raw note into a `PatientProfile`
   (age, sex, diagnoses, main condition, normalized labs).
2. **Retrieve.** Code filters the full registry by age/sex/recruiting status
   (`retrieval/filters.py`), then a hybrid BM25 + OpenAI-embedding index
   (`retrieval/index.py`, combined via reciprocal rank fusion) keeps the top
   `retrieval_k` (default 20,000) candidates.
3. **Gate.** One Jev Noul per retrieved trial — *does this trial study the
   patient's main condition?* — run concurrently under a semaphore. Trials
   above `gate_threshold` (default 0.5), highest-probability first, move on.
4. **Check criteria.** Each gated trial's eligibility text is split into
   individual inclusion/exclusion criteria (`criteria/split.py`). Numeric
   ones are evaluated in code (`criteria/classify.py`); everything else
   becomes one Jev Choice call.
5. **Label, rank, explain.** A trial is `excluded` if any exclusion criterion
   is met or any inclusion criterion isn't; otherwise `eligible`. Rank score
   is the product of every inclusion criterion's "meets" probability and
   every exclusion criterion's "does-not-meet" probability. The top 10
   `eligible`/`excluded` trials get a criterion-by-criterion explanation from
   one final OpenAI call.

Trials that pass the gate but fall outside `criteria_check_top_n` are kept as
`not_relevant` (configurable) for transparency rather than silently dropped.

The design-benchmark demo (`ball_knowledge/pipeline/design_benchmark.py`)
follows the same shape: one OpenAI call parses the query into filters, code
filters on phase/status/condition, one Jev call per candidate trial judges
endpoint/population/design match together, and code computes enrollment
statistics over the matched set.

## Getting started

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # fill in TYPESAFE_API_KEY and OPENAI_API_KEY
```

Optional: `pip install -e ".[rerank]"` and set `COHERE_API_KEY` if you also
want to run the `hybrid_rerank` baseline in the eval harness.

### Get the TREC 2021 Clinical Trials data

```bash
python scripts/download_trec_data.py            # topics + qrels + full ~1.7GB corpus
python scripts/download_trec_data.py --skip-docs # just topics + qrels, for a quick start
```

This pulls the synthetic patient topics, physician relevance judgments
(qrels), and the `ClinicalTrials.gov` 2021-04-27 snapshot (~375k trials, five
zip parts) that `trec-cds.org` publishes for the TREC Clinical Trials track,
verifying each file's MD5 against a known-good checksum and resuming partial
downloads.

### Build the corpus cache and search index

```bash
python scripts/build_index.py                 # full corpus, BM25 + embeddings (slow - offline, once)
python scripts/build_index.py --limit 5000     # fast smoke test on a slice
python scripts/build_index.py --no-embeddings  # BM25 only, skip the slower embedding pass
```

Writes `data/processed/trials.jsonl.gz` (the parsed-once corpus cache) and
`data/index/` (BM25 + OpenAI-embedding index) — both gitignored, both
required by the app, CLI, and eval harness below.

### Run a demo

```bash
# Web UI: query box, rubric chips, ranked list with reasons, cost receipt
uvicorn app.server:app --reload
# then open http://localhost:8000

# Or the CLI
python -m ball_knowledge.cli match --note-file fixtures/sample_patient_note.txt
python -m ball_knowledge.cli design "Completed phase 3 trials in moderate-to-severe atopic dermatitis, with a placebo arm and an EASI-75 endpoint"
```

### Run the evaluation harness

```bash
python -m ball_knowledge.eval.run_eval \
    --systems bm25,hybrid,ball_knowledge \
    --topic-limit 10 \
    --out eval_results
```

Runs every system in the shared results table over TREC-CT-2021 and reports
NDCG@10, eligible-vs-excluded accuracy, LLM/Jev tokens per query, $/query,
and latency — the same table format every Ball Knowledge vertical fills in.
`bm25` and `hybrid` need no API keys; `hybrid_rerank` needs `COHERE_API_KEY`;
`llm_only` and `ball_knowledge` need `OPENAI_API_KEY` (and
`TYPESAFE_API_KEY` for `ball_knowledge`) and cost real money, so keep
`--topic-limit` small while iterating. `llm_only` runs on a slice of
candidates (`--llm-only-slice`, default 1000) and its cost/latency are then
scaled linearly to Ball Knowledge's own pool size so the two rows stay
comparable; its quality is reported from the slice as measured, not scaled.

`TYPESAFE_INPUT_PRICE_PER_MTOK` in `.env` (currently `0.042`, i.e. Jev's
published $0.042/million input tokens — output tokens are free) turns on
Jev-side dollar figures in the receipt; cost cells read "n/a" if it's unset.

### Run the tests

```bash
pytest                              # offline suite: parsing, criteria logic, filters, NDCG, mocked pipeline
pytest -m live -v                   # + one real end-to-end call against OpenAI and TypeSafe (a few cents)
```

## Project layout

```
ball_knowledge/
  config.py                 # env vars + pricing constants behind the cost receipt
  models.py                 # PatientProfile, Trial, Criterion(Result), TrialMatch, ...
  cost_receipt.py            # per-run token/cost/latency tracking
  typesafe_client.py         # the Jev calls: gate (Noul), criterion check (Choice), noul-set batches
  llm_client.py               # the O(1)-per-query OpenAI calls, + the LLM-only baseline judge
  criteria/
    split.py                  # eligibility text -> individual inclusion/exclusion criteria
    classify.py                # numeric (age/lab) criteria evaluated in code, no Jev call
  retrieval/
    filters.py                 # code-side prefilters (age/sex/recruiting; phase/status/condition)
    index.py                   # hybrid BM25 + embedding index, reciprocal rank fusion
    embeddings.py               # OpenAI Embeddings API wrapper (text-embedding-3-small)
  pipeline/
    patient_to_trials.py        # demo 1: patient -> ranked, labeled, explained trials
    design_benchmark.py         # demo 2: design spec -> matched trials + enrollment stats
  data/
    trec_ct.py                  # TREC-CT-2021 topic/qrel/corpus parsing
  eval/
    baselines.py                # bm25 / hybrid / hybrid+rerank / llm-only comparison systems
    ndcg.py                     # NDCG@10 + eligible-vs-excluded accuracy against TREC qrels
    run_eval.py                 # CLI: runs every system, writes the shared results table
  cli.py                        # `match` / `design` command-line entry points
app/
  server.py                     # FastAPI backend for the two demos
  static/                       # vanilla HTML/CSS/JS UI shell (no build step)
scripts/
  download_trec_data.py         # fetches topics, qrels, and the trial corpus with checksum verification
  build_index.py                # parses the corpus once, builds and saves the BM25 + embedding index
fixtures/                       # a 3-trial sample corpus + sample notes, used by the offline test suite
tests/                          # unit + mocked-pipeline tests, plus one opt-in live smoke test
data/                           # raw/processed/index artifacts (gitignored except .gitkeep)
```

## Status

**Working end to end:** structured patient extraction, hybrid retrieval, the
Jev gate and criterion-check pipeline, the design-benchmark pipeline, the cost
receipt, the FastAPI + static-HTML demo UI, the CLI, and the evaluation
harness against TREC-CT-2021 with four baseline systems (BM25, hybrid,
hybrid+Cohere-rerank, LLM-only).

**Known limitations** (see docstrings for the reasoning):
- The numeric-criteria parser (`criteria/classify.py`) recognizes common age
  and lab-threshold phrasings but deliberately falls through to Jev for
  anything it isn't confident about (e.g. thresholds relative to a lab's own
  upper limit of normal, like "ALT ≤ 2.5 × ULN") rather than risk a wrong
  code judgment.
- Jev is priced at $0.042/million input tokens with free output tokens
  (`TYPESAFE_INPUT_PRICE_PER_MTOK=0.042` in `.env`); `$/query` figures read
  "n/a" only if that's left unset — token counts themselves are always exact.
- `run_eval.py`'s `ball_knowledge` row defaults `require_recruiting=False`
  (unlike the app/CLI's production default): TREC-CT-2021's ground truth
  judges eligibility-criteria match, not current recruitment status, and most
  of its "eligible" trials in a 2021 snapshot are long since `Completed` — the
  production prefilter would silently exclude ~98% of the benchmark's own
  ground truth. Pass `--bk-require-recruiting` to opt back in.
- The GiveCampus and Dropbox verticals from the broader Ball Knowledge design
  live in separate scope, not in this repo.

## License

MIT — see [LICENSE](LICENSE).
