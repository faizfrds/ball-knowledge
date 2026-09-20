"""Code-side structured filters, applied before search narrows the candidate pool.

These run over the *entire* registry (hundreds of thousands of trials) so they
stay cheap: plain attribute comparisons, no search or model calls.
"""

from __future__ import annotations

from ball_knowledge.llm_client import DesignQuery
from ball_knowledge.models import PatientProfile, Sex, Trial

RECRUITING_STATUSES = {"recruiting", "not yet recruiting", "enrolling by invitation"}


def passes_patient_prefilter(trial: Trial, patient: PatientProfile, *, require_recruiting: bool = True) -> bool:
    """Age, sex, and recruiting-status gates for the patient-to-trials demo."""
    if require_recruiting and trial.overall_status.strip().lower() not in RECRUITING_STATUSES:
        return False

    gender = trial.gender.strip().lower()
    if patient.sex is not Sex.UNKNOWN and gender not in ("", "all", "both"):
        if gender == "male" and patient.sex is not Sex.MALE:
            return False
        if gender == "female" and patient.sex is not Sex.FEMALE:
            return False

    if patient.age_years is not None:
        if trial.minimum_age_years is not None and patient.age_years < trial.minimum_age_years:
            return False
        if trial.maximum_age_years is not None and patient.age_years > trial.maximum_age_years:
            return False

    return True


def passes_design_filter(trial: Trial, query: DesignQuery) -> bool:
    """Phase, status, and condition-keyword gates for the design-benchmarking demo."""
    if query.phase:
        wanted = query.phase.strip().lower()
        got = trial.phase.strip().lower()
        if wanted not in got and got not in wanted:
            return False

    if query.status:
        if trial.overall_status.strip().lower() != query.status.strip().lower():
            return False

    if query.condition_keywords:
        haystack = " ".join([trial.brief_title, trial.official_title, *trial.conditions]).lower()
        if not any(kw.lower() in haystack for kw in query.condition_keywords):
            return False

    return True
