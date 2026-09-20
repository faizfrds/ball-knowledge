"""End-to-end test of `match_patient_to_trials` with the OpenAI and TypeSafe
(Jev) calls mocked out. This is the one test that exercises the *whole* pipeline
wiring - prefilter -> hybrid search -> gate -> numeric/Jev criteria -> label/rank
-> explain - rather than any single module in isolation, using deterministic
stand-ins for the two network-calling dependencies so it runs offline, free, and
reproducibly in CI.
"""

from __future__ import annotations

import pytest

from ball_knowledge.enrichment.models import ColumnSpec
from ball_knowledge.enrichment.store import EnrichmentStore
from ball_knowledge.models import PatientProfile, Sex, TrialLabel
from ball_knowledge.pipeline import patient_to_trials as pipeline
from ball_knowledge.pipeline.patient_to_trials import MatchConfig, match_patient_to_trials
from ball_knowledge.retrieval.index import TrialIndex
from ball_knowledge.typesafe_client import CriterionCheckResult, GateResult


@pytest.fixture
def index(sample_trials) -> TrialIndex:
    index = TrialIndex(sample_trials)
    index.build_bm25()
    return index


@pytest.fixture
def diabetic_female_patient() -> PatientProfile:
    from ball_knowledge.models import LabValue

    return PatientProfile(
        patient_id="1",
        raw_note="A 45-year-old woman with type 2 diabetes mellitus, HbA1c 8.2%, not pregnant.",
        age_years=45.0,
        sex=Sex.FEMALE,
        diagnoses=["Type 2 Diabetes Mellitus"],
        main_condition="Type 2 Diabetes Mellitus",
        labs={"hba1c": LabValue("hba1c", 8.2, "%")},
    )


def _stub_extract_patient(patient: PatientProfile):
    async def extract_patient(client, note, patient_id, receipt, *, model=None):
        return patient

    return extract_patient


async def _stub_run_gate_batch(requests, receipt, **kwargs):
    """NCT00000001 (diabetes) clears the gate; NCT00000002 (breast cancer) doesn't -
    mirrors what a real gate should do for a diabetes patient's main_condition."""
    probs = {"NCT00000001": 0.95, "NCT00000002": 0.05}
    return {req.key: GateResult(req.key, probs.get(req.key, 0.0)) for req in requests}


async def _stub_run_criterion_batch(requests, receipt, **kwargs):
    """Every non-numeric inclusion criterion is met; every non-numeric exclusion
    criterion is not triggered - i.e. the patient cleanly qualifies on the parts
    of the rubric that require semantic (Jev) judgment."""
    results = {}
    for req in requests:
        kind = req.state["criterion"]["kind"]
        choice = "meets" if kind == "inclusion" else "does_not_meet"
        results[req.key] = CriterionCheckResult(req.key, choice, {choice: 0.9}, 0.9)
    return results


async def _stub_explain_top_trials(client, patient, matches, receipt, *, model=None):
    return {m.trial.nct_id: f"Explanation for {m.trial.nct_id}" for m in matches}


@pytest.fixture(autouse=True)
def mocked_dependencies(monkeypatch, diabetic_female_patient):
    monkeypatch.setattr(pipeline, "extract_patient", _stub_extract_patient(diabetic_female_patient))
    monkeypatch.setattr(pipeline, "run_gate_batch", _stub_run_gate_batch)
    monkeypatch.setattr(pipeline, "run_criterion_batch", _stub_run_criterion_batch)
    monkeypatch.setattr(pipeline, "explain_top_trials", _stub_explain_top_trials)


class TestMatchPatientToTrials:
    async def test_full_pipeline_labels_and_ranks_correctly(self, index):
        patient, matches, receipt = await match_patient_to_trials(
            patient_note="A 45-year-old woman with type 2 diabetes mellitus, HbA1c 8.2%, not pregnant.",
            patient_id="1",
            index=index,
            openai_client=None,
            config=MatchConfig(),
        )

        assert patient.main_condition == "Type 2 Diabetes Mellitus"

        by_id = {m.trial.nct_id: m for m in matches}

        # Cleared the gate, met every inclusion, triggered no exclusion -> eligible.
        diabetes_match = by_id["NCT00000001"]
        assert diabetes_match.label is TrialLabel.ELIGIBLE
        assert diabetes_match.rank_score > 0.0
        assert diabetes_match.explanation == "Explanation for NCT00000001"
        # Age (18-75) and HbA1c (7.0-10.5) criteria must be code-evaluated, not Jev.
        numeric_results = [r for r in diabetes_match.criterion_results if r.criterion.is_numeric]
        assert len(numeric_results) == 2
        assert all(r.evaluated_by == "code" for r in numeric_results)
        assert all(r.verdict.value == "meets" for r in numeric_results)

        # Sex-eligible and recruiting, so it passes the prefilter and gets a gate
        # call, but the gate (0.05, below the 0.5 threshold) correctly screens it
        # out as off-topic before it ever reaches criteria checking - trials that
        # fail the gate outright are dropped from the output entirely (distinct
        # from `beyond_cutoff` trials, which pass the gate but rank beyond
        # `criteria_check_top_n` and are kept as NOT_RELEVANT - see the dedicated
        # test below).
        assert "NCT00000002" not in by_id

        # Pediatric-only trial (max age 17) - patient is 45, fails the code prefilter
        # entirely and never reaches retrieval/gate/criteria.
        assert "NCT00000003" not in by_id

        assert [m.trial.nct_id for m in matches] == ["NCT00000001"]

    async def test_deterministic_explanation_used_when_configured(self, index):
        patient, matches, receipt = await match_patient_to_trials(
            patient_note="A 45-year-old woman with type 2 diabetes mellitus, HbA1c 8.2%, not pregnant.",
            patient_id="1",
            index=index,
            openai_client=None,
            config=MatchConfig(explain_with_llm=False),
        )
        diabetes_match = {m.trial.nct_id: m for m in matches}["NCT00000001"]
        assert "Eligible" in diabetes_match.explanation
        assert "Passed condition gate" in diabetes_match.explanation

    async def test_gated_but_beyond_criteria_top_n_is_labeled_not_relevant(self, index, monkeypatch):
        """Both trials clear the gate, but `criteria_check_top_n=1` means only the
        higher-probability one gets criteria-checked; the other must still appear
        in the output (for eval/transparency) labeled not_relevant, unscored, and
        unexplained - never silently dropped."""

        async def run_gate_batch_both_pass(requests, receipt, **kwargs):
            probs = {"NCT00000001": 0.95, "NCT00000002": 0.6}
            return {req.key: GateResult(req.key, probs[req.key]) for req in requests}

        monkeypatch.setattr(pipeline, "run_gate_batch", run_gate_batch_both_pass)

        _patient, matches, _receipt = await match_patient_to_trials(
            patient_note="...",
            patient_id="1",
            index=index,
            openai_client=None,
            config=MatchConfig(criteria_check_top_n=1),
        )
        by_id = {m.trial.nct_id: m for m in matches}

        assert by_id["NCT00000001"].label is TrialLabel.ELIGIBLE
        cancer_match = by_id["NCT00000002"]
        assert cancer_match.label is TrialLabel.NOT_RELEVANT
        assert cancer_match.rank_score == 0.0
        assert cancer_match.criterion_results == []
        assert cancer_match.explanation is None
        assert cancer_match.gate_probability == pytest.approx(0.6)

        # Ranking: eligible trials must sort ahead of not_relevant ones.
        assert [m.trial.nct_id for m in matches] == ["NCT00000001", "NCT00000002"]

    async def test_exclusion_criterion_met_labels_trial_excluded(self, index, monkeypatch):
        async def run_criterion_batch_pregnant(requests, receipt, **kwargs):
            results = {}
            for req in requests:
                kind = req.state["criterion"]["kind"]
                text = req.state["criterion"]["text"]
                if "Pregnant" in text:
                    choice = "meets"  # patient DOES meet the exclusion criterion
                else:
                    choice = "meets" if kind == "inclusion" else "does_not_meet"
                results[req.key] = CriterionCheckResult(req.key, choice, {choice: 0.9}, 0.9)
            return results

        monkeypatch.setattr(pipeline, "run_criterion_batch", run_criterion_batch_pregnant)

        _patient, matches, _receipt = await match_patient_to_trials(
            patient_note="...",
            patient_id="1",
            index=index,
            openai_client=None,
            config=MatchConfig(),
        )
        diabetes_match = next(m for m in matches if m.trial.nct_id == "NCT00000001")
        assert diabetes_match.label is TrialLabel.EXCLUDED

    async def test_gate_threshold_controls_who_reaches_criteria_checking(self, index, monkeypatch):
        async def run_gate_batch_all_pass(requests, receipt, **kwargs):
            return {req.key: GateResult(req.key, 0.99) for req in requests}

        monkeypatch.setattr(pipeline, "run_gate_batch", run_gate_batch_all_pass)

        _patient, matches, _receipt = await match_patient_to_trials(
            patient_note="...",
            patient_id="1",
            index=index,
            openai_client=None,
            config=MatchConfig(),
        )
        cancer_match = next(m for m in matches if m.trial.nct_id == "NCT00000002")
        # Now that the gate passes it, it must go through criteria checking
        # instead of being short-circuited to not_relevant.
        assert cancer_match.criterion_results != []
        assert cancer_match.label in (TrialLabel.ELIGIBLE, TrialLabel.EXCLUDED)

    async def test_keep_not_relevant_false_drops_gated_out_trials(self, index):
        _patient, matches, _receipt = await match_patient_to_trials(
            patient_note="...",
            patient_id="1",
            index=index,
            openai_client=None,
            config=MatchConfig(keep_not_relevant=False),
        )
        assert "NCT00000002" not in {m.trial.nct_id for m in matches}

    async def test_enrichment_store_bonus_scales_rank_score(self, index):
        """score *= 0.9 + 0.1*bonus: bonus=1.0 (every column maximally positive)
        leaves the base score untouched (the multiplier's ceiling), while
        bonus=0.0 (every column maximally negative) scales it down to 90%."""
        _patient, matches_bare, _receipt = await match_patient_to_trials(
            patient_note="...", patient_id="1", index=index, openai_client=None, config=MatchConfig()
        )
        bare_score = next(m for m in matches_bare if m.trial.nct_id == "NCT00000001").rank_score

        high_store = EnrichmentStore()
        high_store.register_columns([ColumnSpec("high_priority", "...", "yes", "no", weight=1.0)])
        high_store.set("NCT00000001", "high_priority", 1.0)
        _patient, matches_high, _receipt = await match_patient_to_trials(
            patient_note="...", patient_id="1", index=index, openai_client=None, config=MatchConfig(enrichment_store=high_store)
        )
        high_score = next(m for m in matches_high if m.trial.nct_id == "NCT00000001").rank_score

        low_store = EnrichmentStore()
        low_store.register_columns([ColumnSpec("high_priority", "...", "yes", "no", weight=1.0)])
        low_store.set("NCT00000001", "high_priority", 0.0)
        _patient, matches_low, _receipt = await match_patient_to_trials(
            patient_note="...", patient_id="1", index=index, openai_client=None, config=MatchConfig(enrichment_store=low_store)
        )
        low_score = next(m for m in matches_low if m.trial.nct_id == "NCT00000001").rank_score

        assert high_score == pytest.approx(bare_score)
        assert low_score == pytest.approx(bare_score * 0.9)
        assert low_score < high_score

    async def test_unenriched_trial_score_is_unaffected_by_store(self, index):
        """A trial the crawler hasn't reached yet (no columns set) must score
        identically whether or not an (empty) enrichment store is configured -
        `weighted_bonus` returns None, not 0.0, precisely to avoid penalizing it."""
        _patient, matches_bare, _receipt = await match_patient_to_trials(
            patient_note="...", patient_id="1", index=index, openai_client=None, config=MatchConfig()
        )
        bare_score = next(m for m in matches_bare if m.trial.nct_id == "NCT00000001").rank_score

        empty_store = EnrichmentStore()
        _patient, matches_with_store, _receipt = await match_patient_to_trials(
            patient_note="...", patient_id="1", index=index, openai_client=None, config=MatchConfig(enrichment_store=empty_store)
        )
        unenriched_score = next(m for m in matches_with_store if m.trial.nct_id == "NCT00000001").rank_score

        assert unenriched_score == pytest.approx(bare_score)

    async def test_no_candidates_survive_prefilter_returns_empty_matches(self, index, monkeypatch):
        from ball_knowledge.models import LabValue

        male_patient = PatientProfile(
            patient_id="2",
            raw_note="...",
            age_years=90.0,  # too old for the diabetes trial, wrong sex for breast cancer
            sex=Sex.MALE,
            main_condition="Type 2 Diabetes Mellitus",
            labs={"hba1c": LabValue("hba1c", 8.0, "%")},
        )
        monkeypatch.setattr(pipeline, "extract_patient", _stub_extract_patient(male_patient))

        _patient, matches, _receipt = await match_patient_to_trials(
            patient_note="...",
            patient_id="2",
            index=index,
            openai_client=None,
            config=MatchConfig(),
        )

        assert matches == []
