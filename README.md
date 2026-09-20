# Ball Knowledge

Answer hard questions over a large corpus without any model reading the corpus.

You ask in plain English. An LLM turns the question into a **rubric** — a short list of
yes/no gates and graded scales. Cheap hybrid retrieval pulls candidates, a small judge
model (TypeSafe's Jev) scores every candidate against the rubric, and code does the
ranking. The LLM returns only at the end, to write one line of explanation per result.

Every model call sees one question and a few items, so nothing degrades as the pile
grows. Built on 152,713 MIT papers from OpenAlex.

**All measurements are in [RESULTS.md](RESULTS.md)**, including the experiments that
went against the design and the failures worth recording.

---

## Quickstart

```bash
uv sync
cp .env.example .env          # add OPENAI_API_KEY and TYPESAFE_API_KEY
PYTHONPATH=src uv run python -m uvicorn ballknowledge.api:app --port 8000
open http://127.0.0.1:8000
```

One box. Type a query and it runs deep search; paste more than 400 characters and it
treats the text as a description of you and finds the research groups you fit.

A deep search costs roughly **$0.03–0.20** in Jev tokens depending on pool size, so
pre-run and cache anything you plan to demo live — the credits do run out.

## Two things this does

### 1. Enrichment — new columns from unstructured abstracts

Ask one question of every paper in the corpus and get a structured field OpenAlex does
not have. 118,354 abstracts classified for **$3.21**.

| arm | F1 | 95% CI | $/1M items |
|---|---|---|---|
| gpt-5.6-sol | 0.993 | [0.976, 1.000] | $1,618.75 |
| deepseek-v4-flash | 0.980 | [0.954, 1.000] | $103.31 |
| gpt-5.2 | 0.979 | [0.949, 1.000] | $689.21 |
| **jev_per_item** | **0.966** | [0.931, 0.993] | **$27.74** |
| mimo-v2.5 | 0.680 | [0.396, 0.987] | — |

Gold standard: two judge models that are not contestants, **Cohen's κ = 0.964**.
Significance: 1,000-round paired bootstrap. Every CI overlaps with Jev's except the
floor — **statistically indistinguishable accuracy at 25–60× lower cost**.

The column it produced: share of MIT papers using large language models, **0.0% in
2015–2018 rising to 6.2% in 2026**. The 2015 zero is the validation — LLMs did not
exist then, and the method returns the right answer.

### 2. Deep search — rubric-driven retrieval

A query compiles to filters, search phrasings, gates, scores and bonuses. Filters run
as SQL, retrieval fuses BM25 and embeddings, Jev answers the gates over every
candidate, and code ranks what survives. Each result carries a one-line reason and a
receipt showing every token and dollar spent.

Benchmarked over 20 queries with TREC-style pooled judging and a paired bootstrap:

| arm | P@10 | nDCG@10 | median | $/query |
|---|---|---|---|---|
| bm25 | 0.425 | 0.700 | 0.06 s | $0 |
| semantic | 0.500 | 0.687 | 0.70 s | $0 |
| **ball** | **0.625** | **0.824** | 19.45 s | $0.091 |

Rubric-driven search beats both standard retrieval baselines on nDCG@10. Two findings
about the architecture came out of the investigation and are worth reading before
building on it: pool depth measured *worse* than a shallow pool (0.767 at 20k vs 0.867
at 1.5k), and blending retrieval rank into the final score did not help.
See [RESULTS.md §8](RESULTS.md).

## Architecture

```
query
  ├─ compile      LLM writes the rubric                       (1 call)
  ├─ filter       SQL over structured columns                 (DuckDB)
  ├─ retrieve     BM25 + embeddings, reciprocal-rank fusion
  ├─ gate         Jev Noul on every candidate, in waves       (bulk)
  ├─ score        Jev Score/Choice on survivors only
  ├─ rank         code: (1−w)·rubric + w·retrieval_rank
  └─ explain      LLM writes one line per top result          (1 call)
```

| file | role |
|---|---|
| `src/ballknowledge/engine.py` | the pipeline |
| `src/ballknowledge/rubric.py` | query → rubric compiler, explanations |
| `src/ballknowledge/jev.py` | Jev adapter: batching modes, usage accounting, latency |
| `src/ballknowledge/index.py` | hybrid retrieval, BM25 via DuckDB FTS |
| `src/ballknowledge/graph.py` | research groups from co-authorship (Louvain) |
| `src/ballknowledge/embed.py` | checkpointed embedding with a token budget |
| `src/ballknowledge/api.py` | FastAPI backend |
| `web/index.html` | the single-box frontend |
| `scripts/benchmark.py` | enrichment benchmark: dual-judge gold, bootstrap CIs |
| `scripts/compare_baselines.py` | retrieval comparison: pooled judging, nDCG |
| `scripts/rejudge.py` | re-score a finished comparison with a neutral judge |
| `scripts/enrich.py` | corpus-scale enrichment pass |
| `scripts/token_ledger.py` | every token and dollar across every run |

## Second corpus: GiveCampus

The same engine runs over a school's advancement database — see
[GIVECAMPUS.md](GIVECAMPUS.md). Porting took only the three things below, and on the
question *"loyal major donors nobody has asked in five years"* it surfaces **$7.9M of
dollars at stake** in the top five, including a $1.04M lifetime donor with no
assigned officer for three cycles.

## Porting to another corpus

Three things are task-specific; the rest is unchanged.

1. **The item formatter** — how one row becomes text. Jev reads text, and only the
   fields a question names: extra detail costs tokens *and* accuracy.
2. **The schema string** given to the compiler — column names and types.
3. **The rubric** — which the compiler writes for you once it has 1 and 2.

The engine, the gate/score/rank arithmetic, the receipt and the question-writing rules
are corpus-agnostic.

## Rules for writing Jev questions

Literal and complete — put boundary cases in the true/false criteria. One judgment per
question. No numbers, dates or counts; code computes those. Positive phrasing only,
negate with `1−p`. Name only the fields the question needs.

## Reproducing

See [RESULTS.md §10](RESULTS.md).
