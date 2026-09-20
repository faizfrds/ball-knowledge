"""End-to-end test of `run_design_benchmark` with the query parser and Jev calls
mocked out - the design-benchmarking counterpart to
test_pipeline_patient_to_trials.py: code filters (phase/status/condition) ->
Jev endpoint/population/design judgments -> match threshold -> enrollment stats.
"""

from __future__ import annotations

import pytest

from ball_knowledge.llm_client import DesignQuery
from ball_knowledge.pipeline import design_benchmark as pipeline
from ball_knowledge.pipeline.design_benchmark import DesignBenchmarkConfig, run_design_benchmark
from ball_knowledge.retrieval.index import TrialIndex
from ball_knowledge.typesafe_client import NoulSetResult


@pytest.fixture
def index(sample_trials) -> TrialIndex:
    return TrialIndex(sample_trials)  # design_benchmark filters in code only, no search needed


def _stub_parse_design_query(query: DesignQuery):
    async def parse_design_query(client, query_text, receipt, *, model=None):
        return query

    return parse_design_query


class TestRunDesignBenchmark:
    async def test_code_filters_then_jev_judgment_then_enrollment_stats(self, index, monkeypatch):
        query = DesignQuery(
            phase="Phase 3",
            status="Recruiting",
            condition_keywords=["diabetes"],
            population_description="Adults with type 2 diabetes mellitus",
            endpoint_description="Change in HbA1c",
            design_requirements=["placebo arm"],
        )
        monkeypatch.setattr(pipeline, "parse_design_query", _stub_parse_design_query(query))

        async def run_noul_set_batch(requests, noul_questions, receipt, **kwargs):
            assert set(noul_questions) == {"endpoint", "population", "design"}
            return {req.key: NoulSetResult(req.key, {"endpoint": 0.9, "population": 0.9, "design": 0.9}) for req in requests}

        monkeypatch.setattr(pipeline, "run_noul_set_batch", run_noul_set_batch)

        result_query, matches, stats, _receipt = await run_design_benchmark(
            query_text="phase 3 recruiting diabetes trials with a placebo arm, HbA1c endpoint",
            index=index,
            openai_client=None,
            config=DesignBenchmarkConfig(),
        )

        assert result_query is query
        # Only the diabetes trial is Phase 3 + Recruiting + condition-keyword "diabetes".
        assert [m.trial.nct_id for m in matches] == ["NCT00000001"]
        assert matches[0].matched is True
        assert stats.n == 1
        assert stats.values == [320]
        assert stats.median == 320

    async def test_below_threshold_judgment_is_not_matched_and_excluded_from_stats(self, index, monkeypatch):
        query = DesignQuery(phase="Phase 3", endpoint_description="Change in HbA1c")
        monkeypatch.setattr(pipeline, "parse_design_query", _stub_parse_design_query(query))

        async def run_noul_set_batch(requests, noul_questions, receipt, **kwargs):
            return {req.key: NoulSetResult(req.key, {"endpoint": 0.1}) for req in requests}

        monkeypatch.setattr(pipeline, "run_noul_set_batch", run_noul_set_batch)

        _query, matches, stats, _receipt = await run_design_benchmark(
            query_text="phase 3 trials matching an hba1c endpoint",
            index=index,
            openai_client=None,
            config=DesignBenchmarkConfig(),
        )

        assert matches[0].matched is False
        assert stats.n == 0  # unmatched trials excluded from enrollment stats

    async def test_no_semantic_requirements_skips_jev_and_matches_on_code_filters_alone(self, index, monkeypatch):
        query = DesignQuery(phase="Phase 2")  # no endpoint/population/design text at all
        monkeypatch.setattr(pipeline, "parse_design_query", _stub_parse_design_query(query))

        async def run_noul_set_batch_should_not_be_called(requests, noul_questions, receipt, **kwargs):
            raise AssertionError("run_noul_set_batch should not be called with no active questions")

        monkeypatch.setattr(pipeline, "run_noul_set_batch", run_noul_set_batch_should_not_be_called)

        _query, matches, stats, _receipt = await run_design_benchmark(
            query_text="phase 2 trials",
            index=index,
            openai_client=None,
            config=DesignBenchmarkConfig(),
        )

        assert [m.trial.nct_id for m in matches] == ["NCT00000002"]  # the only Phase 2 fixture trial
        assert matches[0].matched is True
        assert stats.n == 1
