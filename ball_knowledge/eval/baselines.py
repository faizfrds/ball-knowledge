"""The comparison systems in the shared results table: keyword search (BM25),
hybrid (BM25 + embeddings), hybrid + Cohere rerank, and LLM-only on the same
rubric. Each returns a `SystemRunResult` shaped the same way Ball Knowledge's own
output is shaped in `run_eval.py`, so scoring is uniform across all five rows.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import openai

from ball_knowledge.config import SETTINGS
from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.llm_client import judge_trial_llm_only
from ball_knowledge.models import PatientProfile, Trial
from ball_knowledge.retrieval.index import TrialIndex

_LABEL_ORDER = {"eligible": 0, "excluded": 1, "not_relevant": 2}


@dataclass
class SystemRunResult:
    topic_id: str
    ranked_nct_ids: list[str]
    predicted_labels: dict[str, str] = field(default_factory=dict)  # only systems that classify, not just rank
    receipt: Receipt = field(default_factory=Receipt)


def run_bm25_only(topic_id: str, topic_text: str, index: TrialIndex, *, k: int = 10) -> SystemRunResult:
    receipt = Receipt()
    hits = index.search(topic_text, k=k, use_bm25=True, use_embeddings=False)
    receipt.mark_first_result()
    return SystemRunResult(topic_id, [index.nct_ids[pos] for pos, _score in hits], receipt=receipt)


def run_hybrid(topic_id: str, topic_text: str, index: TrialIndex, *, k: int = 10) -> SystemRunResult:
    receipt = Receipt()
    hits = index.search(topic_text, k=k, use_bm25=True, use_embeddings=True)
    receipt.mark_first_result()
    return SystemRunResult(topic_id, [index.nct_ids[pos] for pos, _score in hits], receipt=receipt)


def run_hybrid_rerank(topic_id: str, topic_text: str, index: TrialIndex, *, k: int = 10, pool_size: int = 100) -> SystemRunResult:
    """Hybrid retrieval narrows to `pool_size` candidates, then a Cohere reranker
    reorders them. Requires `pip install ball-knowledge[rerank]` and `COHERE_API_KEY`.
    """
    try:
        import cohere
    except ImportError as exc:
        raise RuntimeError("cohere package not installed - run `pip install ball-knowledge[rerank]`") from exc
    if not SETTINGS.cohere_api_key:
        raise RuntimeError("COHERE_API_KEY is not set")

    receipt = Receipt()
    pool = index.search(topic_text, k=pool_size, use_bm25=True, use_embeddings=True)
    positions = [pos for pos, _score in pool]
    documents = [index.trials[pos].search_text()[:2000] for pos in positions]

    client = cohere.Client(SETTINGS.cohere_api_key)
    response = client.rerank(model=SETTINGS.cohere_rerank_model, query=topic_text, documents=documents, top_n=k)
    receipt.mark_first_result()

    billed_units = getattr(getattr(response, "meta", None), "billed_units", None)
    search_units = getattr(billed_units, "search_units", None)
    if search_units is not None and SETTINGS.cohere_price_per_1k_search_units is not None:
        receipt.record_other_cost(search_units / 1000 * SETTINGS.cohere_price_per_1k_search_units)
    else:
        # A billed rerank call happened regardless; record that its cost is unknown
        # rather than letting the total silently treat it as free.
        receipt.record_other_cost(None)

    ranked_positions = [positions[r.index] for r in response.results]
    return SystemRunResult(topic_id, [index.nct_ids[p] for p in ranked_positions], receipt=receipt)


async def run_llm_only(
    topic_id: str,
    patient_note: str,
    candidates: list[Trial],
    openai_client: openai.AsyncOpenAI,
    *,
    concurrency: int = 10,
) -> SystemRunResult:
    """One OpenAI call per candidate trial, using the same eligible / excluded /
    not_relevant rubric Ball Knowledge uses - deliberately the expensive path this
    baseline exists to put a number on. `candidates` is normally a *slice* of the
    full pool (see `run_eval.py`'s scale-up strategy for why running the full
    ~20k-trial pool per topic isn't necessary to measure this fairly).
    """
    receipt = Receipt()
    patient = PatientProfile(patient_id=topic_id, raw_note=patient_note)
    sem = asyncio.Semaphore(concurrency)
    labels: dict[str, str] = {}

    async def one(trial: Trial) -> None:
        async with sem:
            label, _reasoning = await judge_trial_llm_only(openai_client, patient, trial, receipt)
            labels[trial.nct_id] = label

    await asyncio.gather(*(one(t) for t in candidates))
    receipt.mark_first_result()

    ranked = sorted(candidates, key=lambda t: _LABEL_ORDER.get(labels.get(t.nct_id, "not_relevant"), 2))
    return SystemRunResult(topic_id, [t.nct_id for t in ranked], predicted_labels=labels, receipt=receipt)
