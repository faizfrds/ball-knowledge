"""The handful of general-purpose LLM calls the pipeline makes: one per patient
note (structured extraction), one per query (explaining the top 10), and one per
design-benchmark query (parsing the free-text design spec). These are the O(1)
calls Ball Knowledge keeps off the hot path - everything that scales with the
candidate pool (the gate, the criteria checks) goes through Jev instead
(`ball_knowledge.typesafe_client`).

Also home to the single-trial LLM judge used by the "LLM-only, same rubric"
baseline in the eval harness, which deliberately calls the LLM once per candidate
trial so its token/cost/latency numbers show what skipping Jev would cost.

Uses OpenAI's Responses API (`client.responses.parse`) with Pydantic
`text_format` models for structured, schema-validated output.
"""

from __future__ import annotations

import json
import time
from typing import Literal

import openai
from pydantic import BaseModel, Field

from ball_knowledge.config import SETTINGS
from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.models import LabValue, PatientProfile, Sex, Trial, TrialMatch


# ---------------------------------------------------------------------------
# Step 1: patient note -> structured fields
# ---------------------------------------------------------------------------


class _ExtractedLab(BaseModel):
    name: str = Field(description="Normalized lowercase lab/vital code, e.g. 'egfr', 'alt', 'hba1c', 'creatinine', 'ecog', 'bmi'")
    value: float
    unit: str | None = None
    raw_mention: str = Field(default="", description="The phrase in the note this was pulled from")


class _ExtractedPatient(BaseModel):
    age_years: float | None = None
    sex: Literal["male", "female", "unknown"] = "unknown"
    diagnoses: list[str] = Field(default_factory=list, description="All diagnoses/conditions mentioned")
    main_condition: str = Field(description="The single primary condition driving trial eligibility, in plain clinical language")
    labs: list[_ExtractedLab] = Field(default_factory=list)
    other_findings: list[str] = Field(default_factory=list, description="Other clinically relevant facts: prior treatments, performance status, pregnancy, comorbidities, allergies")


EXTRACTION_INSTRUCTIONS = (
    "You extract structured clinical facts from a patient note for clinical-trial "
    "matching. Be literal: only include what the note states or directly implies. "
    "Normalize lab/vital names to short lowercase codes so they can be matched "
    "against trial eligibility criteria in code (e.g. 'eGFR' -> 'egfr', 'ALT' -> "
    "'alt', 'HbA1c' -> 'hba1c', 'ECOG status' -> 'ecog', 'creatinine clearance' -> "
    "'creatinine_clearance'). Convert ages given in months to years. `main_condition` "
    "should be the single disease/indication a trial search would key on."
)


async def extract_patient(
    client: openai.AsyncOpenAI,
    note: str,
    patient_id: str,
    receipt: Receipt,
    *,
    model: str | None = None,
) -> PatientProfile:
    model = model or SETTINGS.openai_model
    start = time.perf_counter()
    response = await client.responses.parse(
        model=model,
        instructions=EXTRACTION_INSTRUCTIONS,
        input=note,
        text_format=_ExtractedPatient,
        reasoning={"effort": "low"},
    )
    receipt.record_llm(
        "patient_extraction", model, response.usage.input_tokens, response.usage.output_tokens, time.perf_counter() - start
    )
    parsed = response.output_parsed
    return PatientProfile(
        patient_id=patient_id,
        raw_note=note,
        age_years=parsed.age_years,
        sex=Sex(parsed.sex),
        diagnoses=parsed.diagnoses,
        main_condition=parsed.main_condition,
        labs={lab.name: LabValue(lab.name, lab.value, lab.unit, lab.raw_mention) for lab in parsed.labs},
        other_findings=parsed.other_findings,
    )


# ---------------------------------------------------------------------------
# Step 5: explain the top 10, criterion by criterion
# ---------------------------------------------------------------------------


class _TrialExplanation(BaseModel):
    nct_id: str
    explanation: str = Field(description="2-4 sentences, criterion by criterion, on why this trial ranked where it did")


class _ExplanationBatch(BaseModel):
    explanations: list[_TrialExplanation]


EXPLAIN_INSTRUCTIONS = (
    "You are a clinical-trial-matching assistant writing explanations for a trial "
    "coordinator, who will make the final call - not a clinician giving medical "
    "advice. For each trial in `trials`, write a short, criterion-by-criterion "
    "explanation of why it is labeled eligible/excluded and ranked where it is: "
    "name the specific inclusion or exclusion criteria that drove the outcome, and "
    "flag any 'not_stated' criteria the coordinator should confirm with the patient "
    "chart. Be concrete and cite the criterion text, not generic reassurance."
)


async def explain_top_trials(
    client: openai.AsyncOpenAI,
    patient: PatientProfile,
    matches: list[TrialMatch],
    receipt: Receipt,
    *,
    model: str | None = None,
) -> dict[str, str]:
    if not matches:
        return {}
    model = model or SETTINGS.openai_model

    def crit_summary(m: TrialMatch) -> list[dict]:
        return [
            {
                "kind": cr.criterion.kind.value,
                "text": cr.criterion.text,
                "verdict": cr.verdict.value,
                "evaluated_by": cr.evaluated_by,
            }
            for cr in m.criterion_results
        ]

    state = {
        "patient": {
            "main_condition": patient.main_condition,
            "age_years": patient.age_years,
            "sex": patient.sex.value,
            "diagnoses": patient.diagnoses,
            "labs": {name: {"value": lab.value, "unit": lab.unit} for name, lab in patient.labs.items()},
        },
        "trials": [
            {
                "nct_id": m.trial.nct_id,
                "title": m.trial.title,
                "label": m.label.value,
                "rank_score": round(m.rank_score, 4),
                "criteria": crit_summary(m),
            }
            for m in matches
        ],
    }

    start = time.perf_counter()
    response = await client.responses.parse(
        model=model,
        instructions=EXPLAIN_INSTRUCTIONS,
        input=json.dumps(state, indent=2),
        text_format=_ExplanationBatch,
        reasoning={"effort": "medium"},
    )
    receipt.record_llm(
        "explain_top10", model, response.usage.input_tokens, response.usage.output_tokens, time.perf_counter() - start
    )
    return {e.nct_id: e.explanation for e in response.output_parsed.explanations}


# ---------------------------------------------------------------------------
# Second demo: parse a free-text design-benchmarking query into filters
# ---------------------------------------------------------------------------


class DesignQuery(BaseModel):
    phase: str | None = Field(default=None, description="e.g. 'Phase 3'; null if unspecified")
    status: str | None = Field(default=None, description="e.g. 'Completed'; null if unspecified")
    condition_keywords: list[str] = Field(default_factory=list, description="Keywords to filter trial conditions/titles on")
    population_description: str = Field(default="", description="The target population, for a semantic match against each trial")
    design_requirements: list[str] = Field(default_factory=list, description="Design elements to check for, e.g. 'placebo arm', 'randomized', 'double-blind'")
    endpoint_description: str = Field(default="", description="The endpoint to match against each trial's outcomes")


DESIGN_QUERY_INSTRUCTIONS = (
    "You turn a biostatistician's free-text trial-design query into structured "
    "filters. `phase` and `status` should match ClinicalTrials.gov vocabulary "
    "('Phase 1'/'Phase 2'/'Phase 3'/'Phase 4', 'Completed'/'Recruiting'/etc) when "
    "the query implies one, else null. Split out condition keywords, the target "
    "population description, required design elements, and the endpoint separately."
)


async def parse_design_query(
    client: openai.AsyncOpenAI, query: str, receipt: Receipt, *, model: str | None = None
) -> DesignQuery:
    model = model or SETTINGS.openai_model
    start = time.perf_counter()
    response = await client.responses.parse(
        model=model,
        instructions=DESIGN_QUERY_INSTRUCTIONS,
        input=query,
        text_format=DesignQuery,
        reasoning={"effort": "low"},
    )
    receipt.record_llm(
        "design_query_parse", model, response.usage.input_tokens, response.usage.output_tokens, time.perf_counter() - start
    )
    return response.output_parsed


# ---------------------------------------------------------------------------
# LLM-only baseline: same rubric, but one big LLM call per trial instead of the
# code-split numeric checks + Jev gate/criteria. This is intentionally the
# expensive path the eval harness measures against.
# ---------------------------------------------------------------------------


class _LLMOnlyVerdict(BaseModel):
    label: Literal["eligible", "excluded", "not_relevant"]
    reasoning: str = Field(description="Criterion-by-criterion reasoning")


LLM_ONLY_INSTRUCTIONS = (
    "You screen one clinical trial against one patient. Read the trial's "
    "eligibility criteria and the patient note, then decide: 'eligible' (the "
    "trial studies the patient's condition and the patient appears to meet the "
    "inclusion criteria and trigger no exclusion criteria), 'excluded' (the trial "
    "studies the patient's condition but the patient fails an inclusion criterion "
    "or triggers an exclusion criterion), or 'not_relevant' (the trial does not "
    "study the patient's condition at all)."
)


async def judge_trial_llm_only(
    client: openai.AsyncOpenAI,
    patient: PatientProfile,
    trial: Trial,
    receipt: Receipt,
    *,
    model: str | None = None,
) -> tuple[str, str]:
    model = model or SETTINGS.openai_baseline_model
    state = {
        "patient_note": patient.raw_note,
        "trial": {
            "nct_id": trial.nct_id,
            "title": trial.title,
            "conditions": trial.conditions,
            "brief_summary": trial.brief_summary,
            "eligibility_criteria": trial.eligibility_criteria_text,
        },
    }
    start = time.perf_counter()
    response = await client.responses.parse(
        model=model,
        instructions=LLM_ONLY_INSTRUCTIONS,
        input=json.dumps(state, indent=2),
        text_format=_LLMOnlyVerdict,
        reasoning={"effort": "medium"},
    )
    receipt.record_llm(
        "llm_only_judge", model, response.usage.input_tokens, response.usage.output_tokens, time.perf_counter() - start
    )
    parsed = response.output_parsed
    return parsed.label, parsed.reasoning
