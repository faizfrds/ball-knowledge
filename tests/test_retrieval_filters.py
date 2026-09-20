from __future__ import annotations

from ball_knowledge.llm_client import DesignQuery
from ball_knowledge.models import PatientProfile, Sex, Trial
from ball_knowledge.retrieval.filters import passes_design_filter, passes_patient_prefilter


def make_patient(**kwargs) -> PatientProfile:
    defaults = dict(patient_id="p1", raw_note="")
    defaults.update(kwargs)
    return PatientProfile(**defaults)


class TestPassesPatientPrefilter:
    def test_matching_patient_passes(self, diabetes_trial: Trial):
        patient = make_patient(age_years=45.0, sex=Sex.FEMALE)
        assert passes_patient_prefilter(diabetes_trial, patient) is True

    def test_not_yet_recruiting_trial_still_passes(self, asthma_trial: Trial):
        # fixture asthma trial's overall_status is "Not yet recruiting", which the
        # filter deliberately treats as recruiting-adjacent (RECRUITING_STATUSES).
        patient = make_patient(age_years=9.0)
        assert passes_patient_prefilter(asthma_trial, patient) is True

    def test_completed_trial_fails_by_default(self, diabetes_trial: Trial):
        diabetes_trial.overall_status = "Completed"
        patient = make_patient(age_years=45.0, sex=Sex.FEMALE)
        assert passes_patient_prefilter(diabetes_trial, patient) is False

    def test_completed_trial_passes_when_not_required(self, diabetes_trial: Trial):
        diabetes_trial.overall_status = "Completed"
        patient = make_patient(age_years=45.0, sex=Sex.FEMALE)
        assert passes_patient_prefilter(diabetes_trial, patient, require_recruiting=False) is True

    def test_sex_mismatch_excludes_female_only_trial(self, breast_cancer_trial: Trial):
        patient = make_patient(age_years=50.0, sex=Sex.MALE)
        assert passes_patient_prefilter(breast_cancer_trial, patient) is False

    def test_unknown_patient_sex_does_not_exclude(self, breast_cancer_trial: Trial):
        patient = make_patient(age_years=50.0, sex=Sex.UNKNOWN)
        assert passes_patient_prefilter(breast_cancer_trial, patient) is True

    def test_age_below_minimum_excludes(self, diabetes_trial: Trial):
        patient = make_patient(age_years=10.0, sex=Sex.FEMALE)
        assert passes_patient_prefilter(diabetes_trial, patient) is False

    def test_age_above_maximum_excludes(self, diabetes_trial: Trial):
        patient = make_patient(age_years=80.0, sex=Sex.FEMALE)
        assert passes_patient_prefilter(diabetes_trial, patient) is False

    def test_unknown_patient_age_does_not_exclude(self, diabetes_trial: Trial):
        patient = make_patient(age_years=None, sex=Sex.FEMALE)
        assert passes_patient_prefilter(diabetes_trial, patient) is True

    def test_all_gender_trial_accepts_either_sex(self, diabetes_trial: Trial):
        assert passes_patient_prefilter(diabetes_trial, make_patient(age_years=30.0, sex=Sex.MALE)) is True
        assert passes_patient_prefilter(diabetes_trial, make_patient(age_years=30.0, sex=Sex.FEMALE)) is True


class TestPassesDesignFilter:
    def test_empty_query_passes_everything(self, diabetes_trial: Trial):
        query = DesignQuery()
        assert passes_design_filter(diabetes_trial, query) is True

    def test_phase_filter_is_substring_matched(self, diabetes_trial: Trial):
        assert passes_design_filter(diabetes_trial, DesignQuery(phase="Phase 3")) is True
        assert passes_design_filter(diabetes_trial, DesignQuery(phase="Phase 2")) is False

    def test_status_filter_is_exact_case_insensitive(self, diabetes_trial: Trial):
        assert passes_design_filter(diabetes_trial, DesignQuery(status="recruiting")) is True
        assert passes_design_filter(diabetes_trial, DesignQuery(status="Completed")) is False

    def test_condition_keyword_matches_title_or_conditions(self, breast_cancer_trial: Trial):
        assert passes_design_filter(breast_cancer_trial, DesignQuery(condition_keywords=["breast cancer"])) is True
        assert passes_design_filter(breast_cancer_trial, DesignQuery(condition_keywords=["diabetes"])) is False

    def test_condition_keywords_are_any_match_not_all(self, breast_cancer_trial: Trial):
        query = DesignQuery(condition_keywords=["diabetes", "breast cancer"])
        assert passes_design_filter(breast_cancer_trial, query) is True
