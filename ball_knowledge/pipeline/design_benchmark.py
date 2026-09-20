"""Second demo: design benchmarking for biostatistics planning.

A free-text design spec ("Completed phase 3 trials in moderate-to-severe atopic
dermatitis, with a placebo arm and an EASI-75 endpoint") becomes: code filters on
phase/status/condition, Jev judgments of endpoint/population/design match (one
call per candidate trial, all three questions asked together), and enrollment-size
statistics over the matched trials to inform sample-size planning.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass

import openai

from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.llm_client import DesignQuery, parse_design_query
from ball_knowledge.models import Trial
from ball_knowledge.retrieval.filters import passes_design_filter
from ball_knowledge.retrieval.index import TrialIndex
from ball_knowledge.typesafe_client import JevRequest, run_noul_set_batch

DESIGN_NOUL_QUESTIONS: dict[str, tuple[str, dict[str, str]]] = {
    "endpoint": (
        "Does this trial's outcome measures (`trial.outcomes`) include the endpoint "
        "described in `query.endpoint_description`, or a direct clinical equivalent?",
        {
            "true": "At least one outcome measure is the same endpoint or a clear equivalent.",
            "false": "No outcome measure matches the described endpoint.",
        },
    ),
    "population": (
        "Does this trial's population (`trial.conditions`, `trial.brief_summary`) "
        "match the population described in `query.population_description`, including "
        "severity/subtype where one is specified?",
        {
            "true": "The trial enrolls this population as described.",
            "false": "The trial's population differs in a material way (severity, subtype, age group, prior treatment, etc.).",
        },
    ),
    "design": (
        "Does this trial's arms (`trial.arm_groups`) and description satisfy every "
        "design requirement listed in `query.design_requirements`?",
        {
            "true": "All listed design requirements are present.",
            "false": "At least one listed design requirement is missing or contradicted.",
        },
    ),
}


@dataclass
class DesignBenchmarkConfig:
    match_threshold: float = 0.5
    max_candidates: int = 3000  # caps Jev calls if the code-filtered pool is very large


@dataclass
class DesignMatch:
    trial: Trial
    probabilities: dict[str, float]
    matched: bool

    @property
    def min_probability(self) -> float | None:
        return min(self.probabilities.values()) if self.probabilities else None


@dataclass
class EnrollmentStats:
    values: list[int]

    @property
    def n(self) -> int:
        return len(self.values)

    @property
    def min(self) -> int | None:
        return min(self.values) if self.values else None

    @property
    def max(self) -> int | None:
        return max(self.values) if self.values else None

    @property
    def median(self) -> float | None:
        return statistics.median(self.values) if self.values else None

    @property
    def mean(self) -> float | None:
        return statistics.fmean(self.values) if self.values else None

    def quantile(self, q: float) -> float | None:
        if not self.values:
            return None
        ordered = sorted(self.values)
        idx = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
        return float(ordered[idx])

    def to_dict(self) -> dict:
        return {
            "n": self.n,
            "min": self.min,
            "max": self.max,
            "median": self.median,
            "mean": self.mean,
            "p25": self.quantile(0.25),
            "p75": self.quantile(0.75),
            "values": self.values,
        }


def _query_state(query: DesignQuery) -> dict:
    return {
        "endpoint_description": query.endpoint_description,
        "population_description": query.population_description,
        "design_requirements": query.design_requirements,
    }


def _trial_design_state(trial: Trial) -> dict:
    return {
        "nct_id": trial.nct_id,
        "title": trial.title,
        "conditions": trial.conditions,
        "brief_summary": trial.brief_summary[:1500],
        "outcomes": trial.outcomes,
        "arm_groups": trial.arm_groups,
    }


async def run_design_benchmark(
    *,
    query_text: str,
    index: TrialIndex,
    openai_client: openai.AsyncOpenAI,
    config: DesignBenchmarkConfig | None = None,
) -> tuple[DesignQuery, list[DesignMatch], EnrollmentStats, Receipt]:
    config = config or DesignBenchmarkConfig()
    receipt = Receipt()

    query = await parse_design_query(openai_client, query_text, receipt)
    receipt.mark_first_result()

    candidates = [t for t in index.trials if passes_design_filter(t, query)][: config.max_candidates]

    active_questions = {
        name: spec
        for name, spec in DESIGN_NOUL_QUESTIONS.items()
        if {
            "endpoint": query.endpoint_description,
            "population": query.population_description,
            "design": query.design_requirements,
        }[name]
    }

    if active_questions:
        requests = [
            JevRequest(key=trial.nct_id, state={"query": _query_state(query), "trial": _trial_design_state(trial)})
            for trial in candidates
        ]
        judgments = await run_noul_set_batch(requests, active_questions, receipt, label="design_judgment")
    else:
        judgments = {}

    matches: list[DesignMatch] = []
    for trial in candidates:
        result = judgments.get(trial.nct_id)
        probabilities = result.probabilities if result else {}
        matched = bool(active_questions) and all(
            probabilities.get(name, 0.0) >= config.match_threshold for name in active_questions
        )
        if not active_questions:
            matched = True  # no semantic requirements given; the code filters are the whole spec
        matches.append(DesignMatch(trial=trial, probabilities=probabilities, matched=matched))

    matches.sort(key=lambda m: -(m.min_probability if m.min_probability is not None else (1.0 if m.matched else 0.0)))

    enrollment_values = [m.trial.enrollment for m in matches if m.matched and m.trial.enrollment]
    stats = EnrollmentStats(values=enrollment_values)

    return query, matches, stats, receipt
