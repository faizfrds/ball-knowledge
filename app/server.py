"""FastAPI backend for the two demos. Serves the static UI shell (query box,
rubric chips, ranked list with reasons, cost receipt) and two JSON endpoints that
run the real pipelines.

    uvicorn app.server:app --reload
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import openai
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ball_knowledge.data.trec_ct import load_corpus_cache
from ball_knowledge.pipeline.design_benchmark import DesignBenchmarkConfig, run_design_benchmark
from ball_knowledge.pipeline.patient_to_trials import MatchConfig, match_patient_to_trials
from ball_knowledge.retrieval.index import TrialIndex

APP_DIR = Path(__file__).resolve().parent
ROOT = APP_DIR.parent

app = FastAPI(title="Ball Knowledge - Regeneron vertical")

_index: TrialIndex | None = None
_openai_client: openai.AsyncOpenAI | None = None


def get_index() -> TrialIndex:
    global _index
    if _index is None:
        corpus_path = ROOT / "data" / "processed" / "trials.jsonl.gz"
        index_dir = ROOT / "data" / "index"
        if not corpus_path.exists() or not index_dir.exists():
            raise HTTPException(status_code=503, detail="Index not built yet - run scripts/build_index.py first.")
        trials = list(load_corpus_cache(corpus_path))
        _index = TrialIndex.load(index_dir, trials)
    return _index


def get_client() -> openai.AsyncOpenAI:
    global _openai_client
    if _openai_client is None:
        _openai_client = openai.AsyncOpenAI()
    return _openai_client


class MatchRequest(BaseModel):
    patient_note: str
    retrieval_k: int = 20000
    criteria_check_top_n: int = 200
    gate_threshold: float = 0.5


class DesignRequest(BaseModel):
    query: str
    match_threshold: float = 0.5


def _with_trial_url(trial_dict: dict) -> dict:
    trial_dict["url"] = f"https://clinicaltrials.gov/study/{trial_dict['nct_id']}"
    return trial_dict


@app.post("/api/match")
async def api_match(req: MatchRequest):
    index = get_index()
    client = get_client()
    config = MatchConfig(
        retrieval_k=req.retrieval_k, criteria_check_top_n=req.criteria_check_top_n, gate_threshold=req.gate_threshold
    )
    patient, matches, receipt = await match_patient_to_trials(
        patient_note=req.patient_note, patient_id="ui-patient", index=index, openai_client=client, config=config
    )

    shown = [m for m in matches if m.label.value != "not_relevant"][:50]
    match_dicts = []
    for m in shown:
        d = dataclasses.asdict(m)
        d["trial"] = _with_trial_url(d["trial"])
        match_dicts.append(d)

    return {
        "patient": dataclasses.asdict(patient),
        "matches": match_dicts,
        "counts": {
            "retrieved": None,  # filled client-side from receipt if useful
            "eligible": sum(1 for m in matches if m.label.value == "eligible"),
            "excluded": sum(1 for m in matches if m.label.value == "excluded"),
        },
        "receipt": receipt.totals().to_dict(),
    }


@app.post("/api/design")
async def api_design(req: DesignRequest):
    index = get_index()
    client = get_client()
    config = DesignBenchmarkConfig(match_threshold=req.match_threshold)
    query, matches, stats, receipt = await run_design_benchmark(
        query_text=req.query, index=index, openai_client=client, config=config
    )

    matched = [m for m in matches if m.matched][:100]
    match_dicts = []
    for m in matched:
        d = dataclasses.asdict(m)
        d["trial"] = _with_trial_url(d["trial"])
        match_dicts.append(d)

    return {
        "query": query.model_dump(),
        "matches": match_dicts,
        "n_candidates": len(matches),
        "enrollment_stats": stats.to_dict(),
        "receipt": receipt.totals().to_dict(),
    }


@app.get("/api/health")
async def health():
    corpus_path = ROOT / "data" / "processed" / "trials.jsonl.gz"
    index_dir = ROOT / "data" / "index"
    return {"index_ready": corpus_path.exists() and index_dir.exists()}


app.mount("/", StaticFiles(directory=APP_DIR / "static", html=True), name="static")
