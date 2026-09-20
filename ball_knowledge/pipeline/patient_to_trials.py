"""The main demo: patient note -> ranked, labeled, explained trials.

    1. Read the patient once (one OpenAI call -> structured PatientProfile).
    2. Retrieve: code filters (age/sex/recruiting status), then hybrid search
       keeps the top `retrieval_k` trials.
    3. Gate: one Jev Noul per retrieved trial - does it study the patient's main
       condition? - kept above `gate_threshold`, top `criteria_check_top_n` by
       gate probability move on.
    4. Check criteria: numeric criteria (age, labs) go to code; the rest become
       one Jev Choice each (meets / does_not_meet / not_stated).
    5. Label (eligible / excluded / not_relevant) and rank by the chance every
       inclusion holds and no exclusion does; explain the top 10 with one more
       OpenAI call.
"""

from __future__ import annotations

from dataclasses import dataclass

import openai
import numpy as np

from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.criteria.classify import try_numeric_evaluation
from ball_knowledge.criteria.rubric_explain import format_deterministic_explanation
from ball_knowledge.criteria.split import build_criteria
from ball_knowledge.enrichment.store import EnrichmentStore
from ball_knowledge.llm_client import explain_top_trials, extract_patient
from ball_knowledge.models import (
    Criterion,
    CriterionKind,
    CriterionResult,
    CriterionVerdict,
    PatientProfile,
    Trial,
    TrialLabel,
    TrialMatch,
)
from ball_knowledge.retrieval.filters import passes_patient_prefilter
from ball_knowledge.retrieval.index import TrialIndex
from ball_knowledge.typesafe_client import CriterionCheckRequest, GateRequest, run_criterion_batch, run_gate_batch

_LABEL_ORDER = {TrialLabel.ELIGIBLE: 0, TrialLabel.EXCLUDED: 1, TrialLabel.NOT_RELEVANT: 2}


@dataclass
class MatchConfig:
    retrieval_k: int = 20000
    gate_threshold: float = 0.5
    criteria_check_top_n: int = 200
    explain_top_n: int = 10
    require_recruiting: bool = True
    keep_not_relevant: bool = True  # keep gated-but-not-top-N trials in the output, for eval/transparency
    use_embeddings: bool = False  # BM25-only retrieval by default (sweet spot, zero embedding API calls)
    explain_with_llm: bool = False  # Deterministic rubric explanations by default (0 second-LLM tokens)
    # Rubric-derived columns from `ball_knowledge.enrichment` (see cli.py's `enrich`
    # subcommand). When set, each trial's weighted-average column probability
    # nudges its rank score by up to 10%; trials the crawler hasn't reached yet
    # are unaffected (bonus 0.0).
    enrichment_store: EnrichmentStore | None = None


def _patient_gate_state(patient: PatientProfile) -> dict:
    return {
        "main_condition": patient.main_condition,
        "age_years": patient.age_years,
        "sex": patient.sex.value,
        "diagnoses": patient.diagnoses,
    }


def _trial_gate_state(trial: Trial) -> dict:
    return {
        "nct_id": trial.nct_id,
        "title": trial.title,
        "conditions": trial.conditions,
        "brief_summary": trial.brief_summary[:1500],
    }


def _criterion_state(patient: PatientProfile, trial: Trial, criterion: Criterion) -> dict:
    return {
        "patient": {
            "main_condition": patient.main_condition,
            "age_years": patient.age_years,
            "sex": patient.sex.value,
            "diagnoses": patient.diagnoses,
            "labs": {name: {"value": lab.value, "unit": lab.unit} for name, lab in patient.labs.items()},
            "other_findings": patient.other_findings,
            "note_excerpt": patient.raw_note[:2000],
        },
        "trial": {"nct_id": trial.nct_id, "title": trial.title},
        "criterion": {"kind": criterion.kind.value, "text": criterion.text},
    }


def _label_and_score(results: list[CriterionResult], *, bonus: float | None = None) -> tuple[TrialLabel, float]:
    excluded = any(
        (r.criterion.kind is CriterionKind.EXCLUSION and r.verdict is CriterionVerdict.MEETS)
        or (r.criterion.kind is CriterionKind.INCLUSION and r.verdict is CriterionVerdict.DOES_NOT_MEET)
        for r in results
    )
    label = TrialLabel.EXCLUDED if excluded else TrialLabel.ELIGIBLE

    score = 1.0
    for r in results:
        score *= r.meets_probability() if r.criterion.kind is CriterionKind.INCLUSION else r.does_not_meet_probability()
    if bonus is not None:
        # Rubric-enrichment columns contribute up to a 10% nudge, same weight the
        # 7-stage engine's bonus term uses (score = G*(0.4+0.6*S) + 0.1*B) - see
        # engine.py. Trials the crawler hasn't reached yet (bonus=None) are left
        # exactly as the base pipeline scored them.
        score *= 0.9 + 0.1 * bonus
    return label, score


def _sort_key(match: TrialMatch) -> tuple[int, float]:
    return (_LABEL_ORDER[match.label], -match.rank_score)


async def match_patient_to_trials(
    *,
    patient_note: str,
    patient_id: str,
    index: TrialIndex,
    openai_client: openai.AsyncOpenAI,
    config: MatchConfig | None = None,
) -> tuple[PatientProfile, list[TrialMatch], Receipt]:
    config = config or MatchConfig()
    receipt = Receipt()

    # Step 1: read the patient once.
    patient = await extract_patient(openai_client, patient_note, patient_id, receipt)

    # Step 2: retrieve.
    candidate_mask = np.array(
        [passes_patient_prefilter(t, patient, require_recruiting=config.require_recruiting) for t in index.trials]
    )
    query_text = f"{patient.main_condition}. {patient_note}"[:3000]
    retrieved = index.search(
        query_text,
        k=config.retrieval_k,
        candidate_mask=candidate_mask,
        use_bm25=True,
        use_embeddings=config.use_embeddings,
    )

    # Step 3: gate - one Noul per retrieved trial.
    gate_requests = [
        GateRequest(key=index.nct_ids[pos], state={"patient": _patient_gate_state(patient), "trial": _trial_gate_state(index.trials[pos])})
        for pos, _score in retrieved
    ]
    gate_results = await run_gate_batch(gate_requests, receipt)
    receipt.mark_first_result()

    score_by_pos = dict(retrieved)
    gated: list[tuple[int, float, float]] = []  # (position, retrieval_score, gate_probability)
    for pos, score in retrieved:
        result = gate_results.get(index.nct_ids[pos])
        if result is not None and result.probability is not None:
            gated.append((pos, score, result.probability))

    gated_pass = sorted((g for g in gated if g[2] >= config.gate_threshold), key=lambda g: -g[2])
    top_for_criteria = gated_pass[: config.criteria_check_top_n]
    beyond_cutoff = gated_pass[config.criteria_check_top_n :]

    # Step 4: check criteria - numeric criteria in code, the rest via Jev Choice.
    criteria_by_trial: dict[str, list[Criterion]] = {}
    numeric_results: dict[str, list[CriterionResult]] = {}
    jev_requests: list[CriterionCheckRequest] = []

    for pos, _score, _gate_prob in top_for_criteria:
        trial = index.trials[pos]
        criteria = build_criteria(trial)
        criteria_by_trial[trial.nct_id] = criteria
        for criterion in criteria:
            numeric = try_numeric_evaluation(criterion, patient)
            if numeric is not None:
                numeric_results.setdefault(trial.nct_id, []).append(numeric)
            else:
                jev_requests.append(
                    CriterionCheckRequest(
                        key=f"{trial.nct_id}::{criterion.index}", state=_criterion_state(patient, trial, criterion)
                    )
                )

    jev_results = await run_criterion_batch(jev_requests, receipt)

    matches: list[TrialMatch] = []
    for pos, score, gate_prob in top_for_criteria:
        trial = index.trials[pos]
        results = list(numeric_results.get(trial.nct_id, []))
        for criterion in criteria_by_trial[trial.nct_id]:
            if criterion.is_numeric:
                continue
            jev_result = jev_results.get(f"{trial.nct_id}::{criterion.index}")
            if jev_result is None or jev_result.choice is None:
                results.append(
                    CriterionResult(criterion, CriterionVerdict.NOT_STATED, "jev", detail=(jev_result.error if jev_result else "no result"))
                )
            else:
                results.append(
                    CriterionResult(criterion, CriterionVerdict(jev_result.choice), "jev", probabilities=jev_result.probabilities)
                )
        results.sort(key=lambda r: r.criterion.index)

        bonus = config.enrichment_store.weighted_bonus(trial.nct_id) if config.enrichment_store is not None else None
        label, rank_score = _label_and_score(results, bonus=bonus)
        matches.append(
            TrialMatch(
                trial=trial, label=label, rank_score=rank_score, gate_probability=gate_prob, retrieval_score=score, criterion_results=results
            )
        )

    if config.keep_not_relevant:
        for pos, score, gate_prob in beyond_cutoff:
            trial = index.trials[pos]
            matches.append(
                TrialMatch(trial=trial, label=TrialLabel.NOT_RELEVANT, rank_score=0.0, gate_probability=gate_prob, retrieval_score=score)
            )

    matches.sort(key=_sort_key)

    # Step 5: explain the top 10.
    explain_candidates = [m for m in matches if m.label in (TrialLabel.ELIGIBLE, TrialLabel.EXCLUDED)][: config.explain_top_n]
    if config.explain_with_llm:
        explanations = await explain_top_trials(openai_client, patient, explain_candidates, receipt)
        for match in explain_candidates:
            match.explanation = explanations.get(match.trial.nct_id)
    else:
        for match in explain_candidates:
            match.explanation = format_deterministic_explanation(match)

    return patient, matches, receipt
