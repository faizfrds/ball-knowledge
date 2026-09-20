from __future__ import annotations

from pathlib import Path

import pytest

from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.enrichment import crawler as crawler_module
from ball_knowledge.enrichment.crawler import run_enrichment_crawler
from ball_knowledge.enrichment.models import ColumnSpec, EnrichmentRubric
from ball_knowledge.enrichment.store import EnrichmentStore
from ball_knowledge.typesafe_client import NoulSetResult


def _rubric() -> EnrichmentRubric:
    return EnrichmentRubric(
        prompt="placebo-controlled trials with a biomarker endpoint",
        columns=[
            ColumnSpec("has_placebo_arm", "Does this trial have a placebo arm?", "yes", "no", weight=1.0),
            ColumnSpec("biomarker_endpoint", "Does this trial use a biomarker primary endpoint?", "yes", "no", weight=2.0),
        ],
    )


async def _stub_run_noul_set_batch(requests, noul_questions, receipt, **kwargs):
    """Deterministic stand-in: NCT001 scores high on both columns, NCT002 low."""
    probs_by_trial = {
        "NCT001": {"has_placebo_arm": 0.9, "biomarker_endpoint": 0.8},
        "NCT002": {"has_placebo_arm": 0.1, "biomarker_endpoint": 0.2},
    }
    return {req.key: NoulSetResult(req.key, probs_by_trial.get(req.key, {})) for req in requests}


class _FakeTrial:
    def __init__(self, nct_id: str):
        self.nct_id = nct_id
        self.title = f"Trial {nct_id}"
        self.conditions = ["Diabetes"]
        self.phase = "Phase 3"
        self.study_type = "Interventional"
        self.brief_summary = "..."
        self.detailed_description = "..."
        self.eligibility_criteria_text = "..."
        self.arm_groups = []
        self.interventions = []
        self.outcomes = []


@pytest.fixture(autouse=True)
def mocked_jev(monkeypatch):
    monkeypatch.setattr(crawler_module, "run_noul_set_batch", _stub_run_noul_set_batch)


class TestRunEnrichmentCrawler:
    async def test_populates_store_with_every_rubric_column(self):
        trials = [_FakeTrial("NCT001"), _FakeTrial("NCT002")]
        store = EnrichmentStore()
        receipt = Receipt()

        await run_enrichment_crawler(trials, _rubric(), store, receipt)

        assert store.get("NCT001") == {"has_placebo_arm": 0.9, "biomarker_endpoint": 0.8}
        assert store.get("NCT002") == {"has_placebo_arm": 0.1, "biomarker_endpoint": 0.2}
        assert store.column_names() == ["has_placebo_arm", "biomarker_endpoint"]

    async def test_skips_trials_already_fully_enriched(self, monkeypatch):
        trials = [_FakeTrial("NCT001"), _FakeTrial("NCT002")]
        store = EnrichmentStore()
        store.register_columns(_rubric().columns)
        store.set("NCT001", "has_placebo_arm", 0.5)
        store.set("NCT001", "biomarker_endpoint", 0.5)

        seen_keys: list[str] = []

        async def recording_batch(requests, noul_questions, receipt, **kwargs):
            seen_keys.extend(req.key for req in requests)
            return await _stub_run_noul_set_batch(requests, noul_questions, receipt, **kwargs)

        monkeypatch.setattr(crawler_module, "run_noul_set_batch", recording_batch)

        await run_enrichment_crawler(trials, _rubric(), store, Receipt())

        assert seen_keys == ["NCT002"]
        # NCT001's pre-existing values are untouched.
        assert store.get("NCT001") == {"has_placebo_arm": 0.5, "biomarker_endpoint": 0.5}

    async def test_checkpoints_to_disk_between_chunks(self, tmp_path: Path):
        trials = [_FakeTrial(f"NCT{i:03d}") for i in range(1, 3)]
        store = EnrichmentStore()

        await run_enrichment_crawler(trials, _rubric(), store, Receipt(), checkpoint_every=1, checkpoint_dir=tmp_path)

        # After the first chunk, progress for at least one trial must already be on disk.
        on_disk = EnrichmentStore.load(tmp_path)
        assert len(on_disk) >= 1

    async def test_no_columns_in_rubric_is_a_noop(self):
        store = EnrichmentStore()
        empty_rubric = EnrichmentRubric(prompt="x", columns=[])
        result = await run_enrichment_crawler([_FakeTrial("NCT001")], empty_rubric, store, Receipt())
        assert result is store
        assert len(store) == 0
