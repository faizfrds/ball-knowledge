"""Thin wrapper around the TypeSafe SDK for the two high-volume Jev calls the
pipeline makes:

- the condition-relevance **gate**: one Noul per retrieved trial ("does this trial
  study the patient's main condition?"), run over the whole retrieval pool.
- the per-criterion **check**: one Choice per non-numeric criterion on the ~200
  gated trials, among meets / does_not_meet / not_stated.

Both run through `AsyncTypeSafeClient` under a semaphore so thousands of
independent (different-state) calls execute concurrently without overwhelming the
API; the SDK's own `RetryPolicy` handles transient failures per call. A call that
still fails after retries is recorded as an error for its key and skipped rather
than aborting the whole batch - a handful of dropped judgments shouldn't sink a
20k-trial run.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from typesafe_sdk import (
    AsyncTypeSafeClient,
    Choice,
    Noul,
    RetryPolicy,
    TypeSafeAPIConnectionError,
    TypeSafeAPIError,
)

from ball_knowledge.config import SETTINGS
from ball_knowledge.cost_receipt import Receipt

CRITERION_CHOICE_CRITERIA = {
    "meets": "The patient's stated facts satisfy this criterion as written.",
    "does_not_meet": "The patient's stated facts contradict or fail this criterion as written.",
    "not_stated": "The note does not contain enough information to judge this criterion either way.",
}

CRITERION_INSTRUCTIONS = (
    "Does the patient described in `patient` meet the eligibility criterion in "
    "`criterion.text`? `criterion.kind` tells you whether this is an inclusion "
    "criterion (the patient would normally need to meet it to qualify) or an "
    "exclusion criterion (meeting it would disqualify the patient) - judge only "
    "whether the patient's stated facts satisfy the criterion as literally written, "
    "not whether that is good or bad for the patient's eligibility."
)

GATE_CRITERIA = {
    "true": (
        "The trial's condition(s) or stated purpose match the patient's main "
        "condition (`patient.main_condition`), or a clear subtype/synonym of it."
    ),
    "false": "The trial targets a different disease, indication, or population than the patient's main condition.",
}

GATE_INSTRUCTIONS = (
    "Does this trial study the patient's main condition? Judge disease/indication "
    "match only; ignore eligibility details like age, sex, or labs - those are "
    "checked separately."
)


@dataclass
class GateRequest:
    key: str
    state: dict


@dataclass
class GateResult:
    key: str
    probability: float | None
    error: str | None = None


@dataclass
class CriterionCheckRequest:
    key: str
    state: dict


@dataclass
class CriterionCheckResult:
    key: str
    choice: str | None
    probabilities: dict[str, float] | None
    confidence: float | None
    error: str | None = None


@dataclass
class JevRequest:
    """Generic (key, state) request, used by `run_noul_set_batch` for callers that
    don't need a dedicated request type (e.g. the design-benchmark demo)."""

    key: str
    state: dict


@dataclass
class NoulSetResult:
    """Result of asking several independent Noul questions about the same state
    in one call (e.g. the design-benchmark's endpoint/population/design match)."""

    key: str
    probabilities: dict[str, float]  # question name -> P(yes)
    error: str | None = None


async def _run_batch(
    requests: list,
    questions_fn,
    extract_fn,
    error_fn,
    receipt: Receipt,
    label: str,
    concurrency: int | None,
    model: str | None,
    max_retries: int,
) -> dict:
    """Fire one `system_one` call per request, all concurrently under a semaphore.

    `questions_fn(req)` builds that request's question set, `extract_fn(req, resp)`
    turns a successful response into a result object, `error_fn(req, message)` does
    the same for a failure. Each request carries its own `state`, so this is the
    fan-out-across-many-different-states pattern (distinct from asking several
    questions about one shared state in a single call).
    """
    sem = asyncio.Semaphore(concurrency or SETTINGS.jev_concurrency)
    results: dict = {}
    retry = RetryPolicy(max_retries=max_retries)

    async with AsyncTypeSafeClient(
        api_key=SETTINGS.typesafe_api_key, model=model or SETTINGS.typesafe_model, retry=retry
    ) as client:

        async def one(req) -> None:
            async with sem:
                start = time.perf_counter()
                try:
                    resp = await client.system_one(state=req.state, questions=questions_fn(req))
                except (TypeSafeAPIError, TypeSafeAPIConnectionError) as exc:
                    results[req.key] = error_fn(req, str(exc))
                    return
                latency = time.perf_counter() - start
                receipt.record_jev(label, resp.model, resp.usage.input_tokens or 0, resp.usage.output_tokens or 0, latency)
                results[req.key] = extract_fn(req, resp)

        await asyncio.gather(*(one(r) for r in requests))
    return results


async def run_gate_batch(
    requests: list[GateRequest],
    receipt: Receipt,
    *,
    concurrency: int | None = None,
    model: str | None = None,
    max_retries: int = 1,
) -> dict[str, GateResult]:
    """One Noul per trial: does it study the patient's main condition?"""
    if not requests:
        return {}
    return await _run_batch(
        requests,
        lambda req: {"relevant": Noul(instructions=GATE_INSTRUCTIONS, criteria=GATE_CRITERIA)},
        lambda req, resp: GateResult(req.key, resp.nouls["relevant"].noul),
        lambda req, err: GateResult(req.key, None, error=err),
        receipt,
        "gate",
        concurrency,
        model,
        max_retries,
    )


async def run_criterion_batch(
    requests: list[CriterionCheckRequest],
    receipt: Receipt,
    *,
    concurrency: int | None = None,
    model: str | None = None,
    max_retries: int = 1,
) -> dict[str, CriterionCheckResult]:
    """One Choice per non-numeric criterion: meets / does_not_meet / not_stated."""
    if not requests:
        return {}

    def extract(req, resp):
        answer = resp.choices["verdict"]
        return CriterionCheckResult(req.key, answer.choice, dict(answer.probabilities), answer.confidence)

    return await _run_batch(
        requests,
        lambda req: {"verdict": Choice(instructions=CRITERION_INSTRUCTIONS, criteria=CRITERION_CHOICE_CRITERIA)},
        extract,
        lambda req, err: CriterionCheckResult(req.key, None, None, None, error=err),
        receipt,
        "criterion_check",
        concurrency,
        model,
        max_retries,
    )


async def run_noul_set_batch(
    requests: list[JevRequest],
    noul_questions: dict[str, tuple[str, dict[str, str]]],
    receipt: Receipt,
    *,
    label: str = "noul_set",
    concurrency: int | None = None,
    model: str | None = None,
    max_retries: int = 1,
) -> dict[str, NoulSetResult]:
    """Ask several independent Noul questions about the same per-request state in
    one call. `noul_questions` maps question name -> (instructions, {"true": ..,
    "false": ..}). Used by the design-benchmark demo (endpoint / population / design
    match, judged together against one trial)."""
    if not requests:
        return {}

    def build(req):
        return {
            name: Noul(instructions=instr, criteria={"true": crit["true"], "false": crit["false"]})
            for name, (instr, crit) in noul_questions.items()
        }

    def extract(req, resp):
        return NoulSetResult(req.key, {name: answer.noul for name, answer in resp.nouls.items()})

    return await _run_batch(
        requests,
        build,
        extract,
        lambda req, err: NoulSetResult(req.key, {}, error=err),
        receipt,
        label,
        concurrency,
        model,
        max_retries,
    )
