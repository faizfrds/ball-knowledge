"""Shared data structures for the patient-to-trials and design-benchmarking pipelines."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Sex(str, Enum):
    MALE = "male"
    FEMALE = "female"
    UNKNOWN = "unknown"


@dataclass
class LabValue:
    """A single lab or vital value pulled out of the patient note."""

    name: str  # normalized, e.g. "egfr", "alt", "hba1c", "creatinine"
    value: float
    unit: str | None = None
    raw_mention: str = ""


@dataclass
class PatientProfile:
    """Structured fields extracted from a patient note by the single step-1 LLM call."""

    patient_id: str
    raw_note: str
    age_years: float | None = None
    sex: Sex = Sex.UNKNOWN
    diagnoses: list[str] = field(default_factory=list)
    main_condition: str = ""
    labs: dict[str, LabValue] = field(default_factory=dict)
    other_findings: list[str] = field(default_factory=list)


@dataclass
class Trial:
    """A ClinicalTrials.gov record, parsed down to the fields the pipeline needs."""

    nct_id: str
    brief_title: str = ""
    official_title: str = ""
    brief_summary: str = ""
    detailed_description: str = ""
    conditions: list[str] = field(default_factory=list)
    gender: str = "All"  # "All" | "Male" | "Female"
    minimum_age_years: float | None = None
    maximum_age_years: float | None = None
    overall_status: str = ""
    phase: str = ""
    study_type: str = ""
    eligibility_criteria_text: str = ""
    enrollment: int | None = None
    start_date: str | None = None
    completion_date: str | None = None
    arm_groups: list[str] = field(default_factory=list)
    interventions: list[str] = field(default_factory=list)
    outcomes: list[str] = field(default_factory=list)

    @property
    def title(self) -> str:
        return self.official_title or self.brief_title

    def search_text(self) -> str:
        parts = [
            self.brief_title,
            self.official_title,
            " ".join(self.conditions),
            self.brief_summary,
            self.detailed_description,
            self.eligibility_criteria_text,
        ]
        return "\n".join(p for p in parts if p)


class CriterionKind(str, Enum):
    INCLUSION = "inclusion"
    EXCLUSION = "exclusion"


class CriterionVerdict(str, Enum):
    MEETS = "meets"
    DOES_NOT_MEET = "does_not_meet"
    NOT_STATED = "not_stated"


@dataclass
class Criterion:
    """One atomic criterion split out of a trial's eligibility text."""

    trial_id: str
    index: int
    kind: CriterionKind
    text: str
    is_numeric: bool = False


@dataclass
class CriterionResult:
    criterion: Criterion
    verdict: CriterionVerdict
    evaluated_by: str  # "code" | "jev"
    detail: str = ""  # short human-readable reason, esp. for the code path
    probabilities: dict[str, float] | None = None  # Jev Choice distribution, when applicable

    def meets_probability(self) -> float:
        """P(meets), used by the rank-score product. Deterministic code results are 0/1;
        Jev-evaluated results use the calibrated Choice probability mass on "meets"."""
        if self.probabilities is not None:
            return self.probabilities.get("meets", 0.0)
        return {
            CriterionVerdict.MEETS: 1.0,
            CriterionVerdict.DOES_NOT_MEET: 0.0,
            CriterionVerdict.NOT_STATED: NOT_STATED_DISCOUNT,
        }[self.verdict]

    def does_not_meet_probability(self) -> float:
        if self.probabilities is not None:
            return self.probabilities.get("does_not_meet", 0.0)
        return {
            CriterionVerdict.MEETS: 0.0,
            CriterionVerdict.DOES_NOT_MEET: 1.0,
            CriterionVerdict.NOT_STATED: NOT_STATED_DISCOUNT,
        }[self.verdict]


# A code-evaluated numeric criterion with an unknown (not-stated) patient value doesn't
# disqualify the trial, but it shouldn't rank as confidently as a confirmed match either.
NOT_STATED_DISCOUNT = 0.85


class TrialLabel(str, Enum):
    ELIGIBLE = "eligible"
    EXCLUDED = "excluded"
    NOT_RELEVANT = "not_relevant"


@dataclass
class TrialMatch:
    """One trial's outcome for a patient query."""

    trial: Trial
    label: TrialLabel
    rank_score: float
    gate_probability: float | None = None
    retrieval_score: float | None = None
    criterion_results: list[CriterionResult] = field(default_factory=list)
    explanation: str | None = None
