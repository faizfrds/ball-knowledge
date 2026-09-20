"""A real, unmocked run of `match_patient_to_trials` against the live OpenAI
and TypeSafe (Jev) APIs, over the tiny 3-trial fixture corpus.

This is the actual end-to-end check: everything else in the suite mocks the LLM
and Jev boundary and verifies the pipeline's own logic, which is necessary but
not sufficient - it can't catch a real API contract drifting out from under the
SDK calls in `llm_client.py`/`typesafe_client.py` (a renamed field, a changed
response shape, a prompt that stops eliciting a parseable answer). This test
catches that class of problem, at the cost of real API calls (a few cents,
~5-10 seconds).

Skipped by default (see pyproject's `addopts = "-m 'not live'"`). Run explicitly
with API keys set:

    OPENAI_API_KEY=... TYPESAFE_API_KEY=... pytest -m live tests/test_live_smoke.py -v
"""

from __future__ import annotations

import os

import openai
import pytest

from ball_knowledge.models import TrialLabel
from ball_knowledge.pipeline.patient_to_trials import MatchConfig, match_patient_to_trials
from ball_knowledge.retrieval.index import TrialIndex

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not os.environ.get("OPENAI_API_KEY"), reason="OPENAI_API_KEY not set"),
    pytest.mark.skipif(not os.environ.get("TYPESAFE_API_KEY"), reason="TYPESAFE_API_KEY not set"),
]


async def test_diabetes_patient_matches_diabetes_trial_end_to_end(sample_trials):
    index = TrialIndex(sample_trials)
    index.build_bm25()  # BM25-only: skip the sentence-transformers download for this smoke test

    patient_note = (
        "A 45-year-old woman with a 3-year history of type 2 diabetes mellitus, "
        "inadequately controlled on metformin. Most recent HbA1c is 8.2%. No "
        "history of type 1 diabetes. Not pregnant."
    )

    client = openai.AsyncOpenAI()
    patient, matches, receipt = await match_patient_to_trials(
        patient_note=patient_note,
        patient_id="live-smoke-1",
        index=index,
        openai_client=client,
        config=MatchConfig(criteria_check_top_n=3, explain_top_n=1),
    )

    # The extraction call actually understood the note.
    assert patient.age_years == pytest.approx(45.0, abs=2.0)
    assert "diabetes" in patient.main_condition.lower()

    # The gate + retrieval correctly surfaced the diabetes trial and not the
    # unrelated breast-cancer/asthma trials, and criteria checking (numeric in
    # code, non-numeric via a real Jev call) landed on a sane label.
    by_id = {m.trial.nct_id: m for m in matches}
    assert "NCT00000001" in by_id
    assert by_id["NCT00000001"].label in (TrialLabel.ELIGIBLE, TrialLabel.EXCLUDED)
    assert any(r.evaluated_by == "jev" for r in by_id["NCT00000001"].criterion_results)

    # The receipt actually recorded token usage for real calls.
    assert receipt.totals().llm_tokens > 0
