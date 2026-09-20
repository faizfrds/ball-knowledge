from __future__ import annotations

import pytest

from ball_knowledge.criteria.classify import (
    detect_lab_keyword,
    parse_numeric_bound,
    try_numeric_evaluation,
)
from ball_knowledge.models import Criterion, CriterionKind, CriterionVerdict, LabValue, PatientProfile, Sex


def make_criterion(text: str, kind: CriterionKind = CriterionKind.INCLUSION, index: int = 0) -> Criterion:
    return Criterion(trial_id="NCT0", index=index, kind=kind, text=text)


def make_patient(**kwargs) -> PatientProfile:
    defaults = dict(patient_id="p1", raw_note="")
    defaults.update(kwargs)
    return PatientProfile(**defaults)


class TestParseNumericBound:
    @pytest.mark.parametrize(
        "text,expected_min,expected_max",
        [
            ("Age 18 Years to 75 Years", 18.0, 75.0),
            ("Age 18-75", 18.0, 75.0),
            ("at least 18 years old", 18.0, None),
            ("18 years or older", 18.0, None),
            ("no more than 65 years", None, 65.0),
            ("65 or younger", None, 65.0),
            ("older than 21", 21.0, None),
            ("younger than 12", None, 12.0),
            ("ALT <= 2.5", None, 2.5),
            ("eGFR >= 30", 30.0, None),
        ],
    )
    def test_bounds(self, text, expected_min, expected_max):
        bound = parse_numeric_bound(text)
        assert bound is not None
        assert bound.min_value == expected_min
        assert bound.max_value == expected_max

    def test_no_number_returns_none(self):
        assert parse_numeric_bound("Must have a confirmed diagnosis") is None


class TestDetectLabKeyword:
    def test_prefers_longest_synonym_match(self):
        assert detect_lab_keyword("systolic blood pressure must be below 140") == "systolic_bp"

    def test_word_boundary_avoids_false_positive(self):
        # "bp" alone isn't a registered synonym, so a word like "bpm" shouldn't match systolic/diastolic bp
        assert detect_lab_keyword("heart rate under 100 bpm") is None

    def test_unrecognized_lab_returns_none(self):
        assert detect_lab_keyword("must not have a rash") is None


class TestTryNumericEvaluation:
    def test_age_criterion_patient_meets(self):
        criterion = make_criterion("Age 18 Years to 75 Years")
        patient = make_patient(age_years=45.0)
        result = try_numeric_evaluation(criterion, patient)
        assert result.verdict is CriterionVerdict.MEETS
        assert result.evaluated_by == "code"
        assert criterion.is_numeric is True

    def test_age_criterion_patient_too_young(self):
        criterion = make_criterion("Age 18 Years to 75 Years")
        patient = make_patient(age_years=12.0)
        result = try_numeric_evaluation(criterion, patient)
        assert result.verdict is CriterionVerdict.DOES_NOT_MEET

    def test_age_criterion_missing_patient_age_is_not_stated(self):
        criterion = make_criterion("Age 18 Years to 75 Years")
        patient = make_patient(age_years=None)
        result = try_numeric_evaluation(criterion, patient)
        assert result.verdict is CriterionVerdict.NOT_STATED

    def test_lab_criterion_evaluated_against_extracted_value(self):
        criterion = make_criterion("HbA1c between 7.0 and 10.5 percent")
        patient = make_patient(labs={"hba1c": LabValue("hba1c", 8.2, "%")})
        result = try_numeric_evaluation(criterion, patient)
        assert result.verdict is CriterionVerdict.MEETS

    def test_lab_criterion_out_of_range_does_not_meet(self):
        criterion = make_criterion("HbA1c between 7.0 and 10.5 percent")
        patient = make_patient(labs={"hba1c": LabValue("hba1c", 6.0, "%")})
        result = try_numeric_evaluation(criterion, patient)
        assert result.verdict is CriterionVerdict.DOES_NOT_MEET

    def test_non_numeric_criterion_falls_through_to_none(self):
        criterion = make_criterion("Histologically confirmed metastatic breast cancer")
        patient = make_patient()
        assert try_numeric_evaluation(criterion, patient) is None

    def test_uln_relative_lab_threshold_falls_through_by_design(self):
        # "2.5 x ULN" isn't resolved to an absolute number - the "2.5" is a
        # multiplier, not a comparable value - so this must route to Jev rather
        # than a (wrong) code judgment against the patient's raw ALT value.
        criterion = make_criterion("ALT <= 2.5 x ULN")
        patient = make_patient(labs={"alt": LabValue("alt", 40.0, "U/L")})
        result = try_numeric_evaluation(criterion, patient)
        assert result is None


class TestMeetsProbability:
    def test_meets_probability_without_jev(self):
        criterion = make_criterion("Age 18 or older")
        result = try_numeric_evaluation(criterion, make_patient(age_years=30.0))
        assert result.meets_probability() == 1.0
        assert result.does_not_meet_probability() == 0.0

    def test_not_stated_uses_discount_not_zero_or_one(self):
        criterion = make_criterion("Age 18 or older")
        result = try_numeric_evaluation(criterion, make_patient(age_years=None))
        assert 0.0 < result.meets_probability() < 1.0
        assert result.meets_probability() == result.does_not_meet_probability()
