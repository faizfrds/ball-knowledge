"""Request-level tests for the FastAPI app (`app/server.py`): HTTP status codes,
request/response JSON shapes, and filtering behavior for `/api/match`,
`/api/design`, and `/api/health` - with the pipeline functions mocked out so
these run offline, free, and fast. The pipeline logic itself (gate/criteria/
label/rank) is covered by test_pipeline_patient_to_trials.py and
test_pipeline_design_benchmark.py; this file only checks the HTTP boundary:
does the server call the pipeline with the request's config, and does it shape
the pipeline's output into the JSON the UI (`app/static/app.js`) expects.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app.server as server
from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.llm_client import DesignQuery
from ball_knowledge.models import (
    Criterion,
    CriterionKind,
    CriterionResult,
    CriterionVerdict,
    PatientProfile,
    Sex,
    Trial,
    TrialLabel,
    TrialMatch,
)
from ball_knowledge.pipeline.design_benchmark import DesignMatch, EnrollmentStats


@pytest.fixture(autouse=True)
def stub_index_and_client(monkeypatch):
    """Every test in this file replaces `match_patient_to_trials` /
    `run_design_benchmark` directly, so the real index/OpenAI client built by
    `get_index()`/`get_client()` are never actually used - stub them out so no
    test depends on a built index or a real API key being present."""
    monkeypatch.setattr(server, "get_index", lambda: object())
    monkeypatch.setattr(server, "get_client", lambda: object())


@pytest.fixture
def client() -> TestClient:
    return TestClient(server.app)


def _trial(nct_id: str = "NCT00000001", **kwargs) -> Trial:
    defaults = dict(brief_title="A Study of Drug X in Rheumatoid Arthritis", conditions=["Rheumatoid Arthritis"])
    defaults.update(kwargs)
    return Trial(nct_id=nct_id, **defaults)


def _eligible_match(nct_id: str = "NCT00000001") -> TrialMatch:
    trial = _trial(nct_id)
    criterion = Criterion(trial_id=trial.nct_id, index=0, kind=CriterionKind.INCLUSION, text="Age 18 to 75 years", is_numeric=True)
    result = CriterionResult(criterion, CriterionVerdict.MEETS, "code", detail="patient age (years) = 62 vs required range [18.0, 75.0]")
    return TrialMatch(
        trial=trial, label=TrialLabel.ELIGIBLE, rank_score=0.95, gate_probability=0.9, retrieval_score=1.2,
        criterion_results=[result], explanation="Meets the age criterion.",
    )


class TestApiHealth:
    def test_index_not_ready_when_files_missing(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(server, "ROOT", tmp_path)
        resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json() == {"index_ready": False}

    def test_index_ready_when_both_artifacts_present(self, client, tmp_path, monkeypatch):
        (tmp_path / "data" / "processed").mkdir(parents=True)
        (tmp_path / "data" / "processed" / "trials.jsonl.gz").write_bytes(b"")
        (tmp_path / "data" / "index").mkdir(parents=True)
        monkeypatch.setattr(server, "ROOT", tmp_path)
        resp = client.get("/api/health")
        assert resp.json() == {"index_ready": True}


class TestApiMatch:
    def test_returns_patient_matches_and_receipt(self, client, monkeypatch):
        async def stub(*, patient_note, patient_id, index, openai_client, config):
            patient = PatientProfile(
                patient_id=patient_id, raw_note=patient_note, age_years=62.0, sex=Sex.FEMALE, main_condition="Rheumatoid Arthritis"
            )
            receipt = Receipt()
            receipt.record_llm("patient_extraction", "gpt-5.5", 100, 50, 0.5)
            return patient, [_eligible_match()], receipt

        monkeypatch.setattr(server, "match_patient_to_trials", stub)

        resp = client.post("/api/match", json={"patient_note": "A 62-year-old woman with RA."})

        assert resp.status_code == 200
        body = resp.json()
        assert body["patient"]["main_condition"] == "Rheumatoid Arthritis"
        assert body["patient"]["sex"] == "female"
        assert len(body["matches"]) == 1
        match = body["matches"][0]
        assert match["label"] == "eligible"
        assert match["trial"]["nct_id"] == "NCT00000001"
        assert match["trial"]["url"] == "https://clinicaltrials.gov/study/NCT00000001"
        assert match["criterion_results"][0]["verdict"] == "meets"
        assert body["counts"] == {"retrieved": None, "eligible": 1, "excluded": 0}
        assert body["receipt"]["llm_tokens"] == 150

    def test_drops_not_relevant_trials_from_the_response(self, client, monkeypatch):
        async def stub(*, patient_note, patient_id, index, openai_client, config):
            not_relevant = TrialMatch(trial=_trial("NCT00000002"), label=TrialLabel.NOT_RELEVANT, rank_score=0.0)
            return PatientProfile(patient_id=patient_id, raw_note=patient_note, main_condition="X"), [_eligible_match(), not_relevant], Receipt()

        monkeypatch.setattr(server, "match_patient_to_trials", stub)

        resp = client.post("/api/match", json={"patient_note": "..."})
        body = resp.json()
        assert [m["trial"]["nct_id"] for m in body["matches"]] == ["NCT00000001"]
        # not_relevant is still reflected nowhere in eligible/excluded counts.
        assert body["counts"]["eligible"] == 1
        assert body["counts"]["excluded"] == 0

    def test_caps_returned_matches_at_fifty(self, client, monkeypatch):
        async def stub(*, patient_note, patient_id, index, openai_client, config):
            matches = [_eligible_match(f"NCT{i:08d}") for i in range(75)]
            return PatientProfile(patient_id=patient_id, raw_note=patient_note, main_condition="X"), matches, Receipt()

        monkeypatch.setattr(server, "match_patient_to_trials", stub)

        resp = client.post("/api/match", json={"patient_note": "..."})
        assert len(resp.json()["matches"]) == 50

    def test_request_fields_become_match_config(self, client, monkeypatch):
        captured = {}

        async def stub(*, patient_note, patient_id, index, openai_client, config):
            captured["config"] = config
            return PatientProfile(patient_id=patient_id, raw_note=patient_note, main_condition="X"), [], Receipt()

        monkeypatch.setattr(server, "match_patient_to_trials", stub)

        client.post(
            "/api/match",
            json={"patient_note": "...", "retrieval_k": 500, "criteria_check_top_n": 25, "gate_threshold": 0.7},
        )

        config = captured["config"]
        assert config.retrieval_k == 500
        assert config.criteria_check_top_n == 25
        assert config.gate_threshold == 0.7

    def test_missing_patient_note_is_a_422(self, client):
        resp = client.post("/api/match", json={})
        assert resp.status_code == 422

    def test_pipeline_exception_becomes_a_500(self, monkeypatch):
        async def stub(*, patient_note, patient_id, index, openai_client, config):
            raise RuntimeError("boom")

        monkeypatch.setattr(server, "match_patient_to_trials", stub)
        # The default TestClient re-raises unhandled exceptions (useful for the
        # other tests, which should fail loudly rather than as a generic 500) -
        # this test is specifically about the production behavior for a real
        # client, so it needs the exception translated into a response instead.
        no_raise_client = TestClient(server.app, raise_server_exceptions=False)
        resp = no_raise_client.post("/api/match", json={"patient_note": "..."})
        assert resp.status_code == 500


class TestApiDesign:
    def test_returns_query_matches_and_enrollment_stats(self, client, monkeypatch):
        async def stub(*, query_text, index, openai_client, config):
            query = DesignQuery(phase="Phase 3", status="Completed", condition_keywords=["rheumatoid arthritis"], endpoint_description="ACR20")
            trial = _trial(enrollment=500)
            match = DesignMatch(trial=trial, probabilities={"endpoint": 0.9, "population": 0.8}, matched=True)
            return query, [match], EnrollmentStats(values=[500]), Receipt()

        monkeypatch.setattr(server, "run_design_benchmark", stub)

        resp = client.post("/api/design", json={"query": "phase 3 completed RA trials"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["query"]["phase"] == "Phase 3"
        assert body["n_candidates"] == 1
        assert body["matches"][0]["trial"]["url"] == "https://clinicaltrials.gov/study/NCT00000001"
        assert body["matches"][0]["probabilities"] == {"endpoint": 0.9, "population": 0.8}
        assert body["enrollment_stats"]["n"] == 1
        assert body["enrollment_stats"]["median"] == 500

    def test_drops_unmatched_trials_from_the_response(self, client, monkeypatch):
        async def stub(*, query_text, index, openai_client, config):
            matched = DesignMatch(trial=_trial("NCT00000001"), probabilities={}, matched=True)
            unmatched = DesignMatch(trial=_trial("NCT00000002"), probabilities={}, matched=False)
            # n_candidates reflects every code-filtered candidate, matched or not.
            return DesignQuery(), [matched, unmatched], EnrollmentStats(values=[]), Receipt()

        monkeypatch.setattr(server, "run_design_benchmark", stub)

        resp = client.post("/api/design", json={"query": "..."})
        body = resp.json()
        assert [m["trial"]["nct_id"] for m in body["matches"]] == ["NCT00000001"]
        assert body["n_candidates"] == 2

    def test_missing_query_is_a_422(self, client):
        resp = client.post("/api/design", json={})
        assert resp.status_code == 422


class TestStaticUI:
    def test_root_serves_the_app_shell(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        assert "Ball Knowledge" in resp.text
