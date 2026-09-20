from ball_knowledge.llm_client import DesignQuery
from ball_knowledge.models import PatientProfile, Sex, Trial
from ball_knowledge.retrieval.filters import passes_design_filter, passes_patient_prefilter


def make_trial(**kwargs) -> Trial:
    defaults = dict(nct_id="NCT1", overall_status="Recruiting", gender="All")
    defaults.update(kwargs)
    return Trial(**defaults)


def make_patient(**kwargs) -> PatientProfile:
    defaults = dict(patient_id="p1", raw_note="")
    defaults.update(kwargs)
    return PatientProfile(**defaults)


def test_prefilter_rejects_non_recruiting():
    trial = make_trial(overall_status="Completed")
    patient = make_patient()
    assert passes_patient_prefilter(trial, patient) is False


def test_prefilter_allows_non_recruiting_when_not_required():
    trial = make_trial(overall_status="Completed")
    patient = make_patient()
    assert passes_patient_prefilter(trial, patient, require_recruiting=False) is True


def test_prefilter_gender_mismatch():
    trial = make_trial(gender="Male")
    patient = make_patient(sex=Sex.FEMALE)
    assert passes_patient_prefilter(trial, patient) is False


def test_prefilter_gender_match():
    trial = make_trial(gender="Female")
    patient = make_patient(sex=Sex.FEMALE)
    assert passes_patient_prefilter(trial, patient) is True


def test_prefilter_unknown_sex_never_excluded_on_gender():
    trial = make_trial(gender="Male")
    patient = make_patient(sex=Sex.UNKNOWN)
    assert passes_patient_prefilter(trial, patient) is True


def test_prefilter_age_bounds():
    trial = make_trial(minimum_age_years=18, maximum_age_years=65)
    assert passes_patient_prefilter(trial, make_patient(age_years=30)) is True
    assert passes_patient_prefilter(trial, make_patient(age_years=10)) is False
    assert passes_patient_prefilter(trial, make_patient(age_years=80)) is False
    assert passes_patient_prefilter(trial, make_patient(age_years=None)) is True  # unknown age isn't excluded


def test_design_filter_phase_and_status():
    trial = make_trial(phase="Phase 3", overall_status="Completed", brief_title="A dermatitis study")
    matching = DesignQuery(phase="Phase 3", status="Completed")
    mismatching = DesignQuery(phase="Phase 2", status="Completed")
    assert passes_design_filter(trial, matching) is True
    assert passes_design_filter(trial, mismatching) is False


def test_design_filter_condition_keywords():
    trial = make_trial(conditions=["Atopic Dermatitis"])
    assert passes_design_filter(trial, DesignQuery(condition_keywords=["dermatitis"])) is True
    assert passes_design_filter(trial, DesignQuery(condition_keywords=["psoriasis"])) is False
