from ball_knowledge.criteria.classify import parse_numeric_bound, try_numeric_evaluation
from ball_knowledge.models import Criterion, CriterionKind, CriterionVerdict, LabValue, PatientProfile, Sex


def make_patient(**kwargs) -> PatientProfile:
    defaults = dict(patient_id="p1", raw_note="", sex=Sex.UNKNOWN)
    defaults.update(kwargs)
    return PatientProfile(**defaults)


def make_criterion(text: str, kind: CriterionKind = CriterionKind.INCLUSION) -> Criterion:
    return Criterion(trial_id="NCT1", index=0, kind=kind, text=text)


def test_parse_numeric_bound_range():
    assert parse_numeric_bound("Age 18 to 75 years") == parse_numeric_bound("Age 18-75 years")


def test_parse_numeric_bound_ge_phrasings():
    assert parse_numeric_bound("Age >= 18 years").min_value == 18
    assert parse_numeric_bound("at least 18 years old").min_value == 18
    assert parse_numeric_bound("18 years or older").min_value == 18


def test_parse_numeric_bound_le_phrasings():
    assert parse_numeric_bound("Age <= 65 years").max_value == 65
    assert parse_numeric_bound("65 years or younger").max_value == 65


def test_age_criterion_meets():
    patient = make_patient(age_years=62)
    result = try_numeric_evaluation(make_criterion("Age 18 to 75 years"), patient)
    assert result is not None
    assert result.verdict is CriterionVerdict.MEETS
    assert result.evaluated_by == "code"


def test_age_criterion_does_not_meet():
    patient = make_patient(age_years=16)
    result = try_numeric_evaluation(make_criterion("Age 18 to 75 years"), patient)
    assert result.verdict is CriterionVerdict.DOES_NOT_MEET


def test_age_criterion_not_stated_when_missing():
    patient = make_patient(age_years=None)
    result = try_numeric_evaluation(make_criterion("Age 18 to 75 years"), patient)
    assert result.verdict is CriterionVerdict.NOT_STATED


def test_lab_criterion_meets():
    patient = make_patient(labs={"egfr": LabValue("egfr", 78, "mL/min/1.73m2")})
    result = try_numeric_evaluation(make_criterion("eGFR at least 45 mL/min/1.73m2"), patient)
    assert result is not None
    assert result.verdict is CriterionVerdict.MEETS


def test_lab_criterion_evaluated_literally_regardless_of_inclusion_exclusion_kind():
    # `try_numeric_evaluation` only judges whether the patient's value satisfies the
    # criterion text as written; whether that's good or bad news is decided later,
    # by ranking logic that knows the criterion's kind (inclusion vs exclusion).
    patient = make_patient(labs={"platelet_count": LabValue("platelet_count", 80, "x10^9/L")})
    result = try_numeric_evaluation(
        make_criterion("Platelet count less than 100 x10^9/L", kind=CriterionKind.EXCLUSION), patient
    )
    assert result.verdict is CriterionVerdict.MEETS  # 80 < 100 is literally true


def test_lab_criterion_does_not_meet():
    patient = make_patient(labs={"platelet_count": LabValue("platelet_count", 150, "x10^9/L")})
    result = try_numeric_evaluation(
        make_criterion("Platelet count less than 100 x10^9/L", kind=CriterionKind.EXCLUSION), patient
    )
    assert result.verdict is CriterionVerdict.DOES_NOT_MEET  # 150 < 100 is literally false


def test_non_numeric_criterion_falls_through_to_jev():
    patient = make_patient()
    result = try_numeric_evaluation(make_criterion("Willing and able to provide informed consent"), patient)
    assert result is None


def test_uln_relative_lab_falls_through_to_jev():
    # No absolute threshold to compare against - must not be silently mis-evaluated by code.
    patient = make_patient(labs={"alt": LabValue("alt", 20, "U/L")})
    result = try_numeric_evaluation(make_criterion("ALT and AST less than 2.5 x ULN"), patient)
    assert result is None
