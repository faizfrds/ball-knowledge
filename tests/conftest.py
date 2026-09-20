from __future__ import annotations

from pathlib import Path

import pytest

from ball_knowledge.data.trec_ct import iter_trial_xml_bytes, parse_trial_xml
from ball_knowledge.models import PatientProfile, Sex, Trial

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
SAMPLE_CORPUS_ZIP = FIXTURES_DIR / "trec_ct_sample.zip"
SAMPLE_TOPICS_XML = FIXTURES_DIR / "topics_sample.xml"
SAMPLE_QRELS_TXT = FIXTURES_DIR / "qrels_sample.txt"


@pytest.fixture
def sample_trials() -> list[Trial]:
    """The 3 fixture trials (diabetes, breast cancer, pediatric asthma), parsed
    from fixtures/trec_ct_sample.zip via the real XML parser."""
    return [parse_trial_xml(b) for b in iter_trial_xml_bytes([SAMPLE_CORPUS_ZIP])]


@pytest.fixture
def diabetes_trial(sample_trials: list[Trial]) -> Trial:
    return next(t for t in sample_trials if t.nct_id == "NCT00000001")


@pytest.fixture
def breast_cancer_trial(sample_trials: list[Trial]) -> Trial:
    return next(t for t in sample_trials if t.nct_id == "NCT00000002")


@pytest.fixture
def asthma_trial(sample_trials: list[Trial]) -> Trial:
    return next(t for t in sample_trials if t.nct_id == "NCT00000003")


@pytest.fixture
def diabetic_patient() -> PatientProfile:
    from ball_knowledge.models import LabValue

    return PatientProfile(
        patient_id="1",
        raw_note="A 45-year-old woman with type 2 diabetes mellitus, HbA1c 8.2%.",
        age_years=45.0,
        sex=Sex.FEMALE,
        diagnoses=["Type 2 Diabetes Mellitus"],
        main_condition="Type 2 Diabetes Mellitus",
        labs={"hba1c": LabValue("hba1c", 8.2, "%", "HbA1c 8.2%")},
    )
