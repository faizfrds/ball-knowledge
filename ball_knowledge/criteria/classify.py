"""Numeric criteria (age, labs) are evaluated in code against the patient's
extracted values, never sent to Jev. This module recognizes the common
ClinicalTrials.gov phrasings for age and lab thresholds and evaluates them; a
criterion it doesn't confidently recognize returns `None` from
`try_numeric_evaluation`, and the caller routes it to a Jev Choice instead. That
"fall through when unsure" behavior is deliberate: a wrong code judgment is worse
than one more Jev call.

Known limitation: lab comparisons assume the criterion's units match the patient's
extracted units (no unit conversion), and thresholds phrased relative to a lab's
upper limit of normal (e.g. "ALT <= 2.5 x ULN") aren't resolved to an absolute
number, so they fall through to Jev by design.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ball_knowledge.models import Criterion, CriterionResult, CriterionVerdict, PatientProfile

_AGE_KEYWORD_RE = re.compile(r"\bage[ds]?\b", re.IGNORECASE)
# A threshold phrased relative to the lab's own upper limit of normal (e.g. "ALT <=
# 2.5 x ULN") isn't an absolute number - the "2.5" a naive regex would extract is a
# multiplier, not a comparable value, so these must fall through to Jev rather than
# be evaluated against the patient's raw lab value.
_ULN_RELATIVE_RE = re.compile(r"\bULN\b|upper limits?\s+of\s+normal", re.IGNORECASE)

_NUM = r"(\d+(?:\.\d+)?)"
_RANGE_RE = re.compile(rf"{_NUM}\s*(?:years?|yrs?)?\s*(?:-|to|and)\s*{_NUM}", re.IGNORECASE)
# Each covers both phrasing orders: "at least 18" and "18 or older".
_GE_RE = re.compile(
    rf"(?:at least|no less than|>=|≥)\D{{0,10}}{_NUM}"
    rf"|{_NUM}\D{{0,15}}(?:or older|or above|and above|or greater)",
    re.IGNORECASE,
)
_LE_RE = re.compile(
    rf"(?:at most|no more than|<=|≤)\D{{0,10}}{_NUM}"
    rf"|{_NUM}\D{{0,15}}(?:or younger|or below|and below|or less)",
    re.IGNORECASE,
)
_GT_RE = re.compile(rf"(?:older than|greater than|more than)\D{{0,10}}{_NUM}|>{_NUM}", re.IGNORECASE)
_LT_RE = re.compile(rf"(?:younger than|less than|under)\D{{0,10}}{_NUM}|<{_NUM}", re.IGNORECASE)

LAB_SYNONYMS: dict[str, list[str]] = {
    "egfr": ["egfr", "estimated glomerular filtration rate"],
    "creatinine_clearance": ["creatinine clearance", "crcl"],
    "creatinine": ["serum creatinine", "creatinine"],
    "alt": ["alt", "alanine aminotransferase", "sgpt"],
    "ast": ["ast", "aspartate aminotransferase", "sgot"],
    "bilirubin": ["total bilirubin", "bilirubin"],
    "hba1c": ["hba1c", "hemoglobin a1c", "glycated hemoglobin"],
    "hemoglobin": ["hemoglobin", "hgb"],
    "platelet_count": ["platelet count", "platelets"],
    "wbc": ["white blood cell count", "wbc", "leukocyte count"],
    "anc": ["absolute neutrophil count", "anc", "neutrophil count"],
    "ecog": ["ecog performance status", "ecog"],
    "bmi": ["body mass index", "bmi"],
    "inr": ["international normalized ratio", "inr"],
    "ldl": ["ldl cholesterol", "ldl"],
    "hdl": ["hdl cholesterol", "hdl"],
    "triglycerides": ["triglycerides"],
    "systolic_bp": ["systolic blood pressure", "systolic bp"],
    "diastolic_bp": ["diastolic blood pressure", "diastolic bp"],
}
# Longest synonym first so "systolic blood pressure" is tried before generic "bp"-ish terms.
_LAB_CANDIDATES = sorted(
    ((code, syn) for code, syns in LAB_SYNONYMS.items() for syn in syns), key=lambda pair: -len(pair[1])
)


@dataclass
class NumericBound:
    min_value: float | None
    max_value: float | None


def parse_numeric_bound(text: str) -> NumericBound | None:
    match = _RANGE_RE.search(text)
    if match:
        a, b = float(match.group(1)), float(match.group(2))
        return NumericBound(min(a, b), max(a, b))
    for regex, is_lower_bound in [(_GE_RE, True), (_LE_RE, False), (_GT_RE, True), (_LT_RE, False)]:
        match = regex.search(text)
        if match:
            value = float(next(g for g in match.groups() if g is not None))
            return NumericBound(value, None) if is_lower_bound else NumericBound(None, value)
    return None


def detect_lab_keyword(text: str) -> str | None:
    lowered = text.lower()
    for code, synonym in _LAB_CANDIDATES:
        if re.search(rf"\b{re.escape(synonym)}\b", lowered):
            return code
    return None


def try_numeric_evaluation(criterion: Criterion, patient: PatientProfile) -> CriterionResult | None:
    """Returns a code-evaluated result if this criterion is a recognized age or lab
    threshold, else `None` (caller should route it to Jev)."""
    text = criterion.text

    if _AGE_KEYWORD_RE.search(text):
        bound = parse_numeric_bound(text)
        if bound is not None:
            criterion.is_numeric = True
            return _evaluate_bound(criterion, bound, patient.age_years, "age (years)")

    lab_code = detect_lab_keyword(text)
    if lab_code is not None and not _ULN_RELATIVE_RE.search(text):
        bound = parse_numeric_bound(text)
        if bound is not None:
            criterion.is_numeric = True
            lab = patient.labs.get(lab_code)
            patient_value = lab.value if lab else None
            return _evaluate_bound(criterion, bound, patient_value, lab_code)

    return None


def _evaluate_bound(criterion: Criterion, bound: NumericBound, patient_value: float | None, label: str) -> CriterionResult:
    if patient_value is None:
        return CriterionResult(
            criterion, CriterionVerdict.NOT_STATED, "code", detail=f"patient's {label} was not extracted from the note"
        )

    meets = True
    if bound.min_value is not None and patient_value < bound.min_value:
        meets = False
    if bound.max_value is not None and patient_value > bound.max_value:
        meets = False

    bound_desc = f"[{bound.min_value if bound.min_value is not None else '-inf'}, {bound.max_value if bound.max_value is not None else '+inf'}]"
    detail = f"patient {label} = {patient_value} vs required range {bound_desc}"
    verdict = CriterionVerdict.MEETS if meets else CriterionVerdict.DOES_NOT_MEET
    return CriterionResult(criterion, verdict, "code", detail=detail)
