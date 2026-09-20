"""Turns a free-text rubric prompt ("Trials with a placebo-controlled,
double-blind design and a biomarker-based primary endpoint") into a list of
`ColumnSpec`s the crawler can ask Jev about, one per trial.

This is the same "compile a free-text ask into a structured, checkable rubric"
move `ball_knowledge.llm_client.parse_design_query` already makes for the
design-benchmark demo - here the output is column definitions instead of
code-side filters, because these questions need Jev's per-trial semantic
judgment rather than a structured field comparison."""

from __future__ import annotations

import re
import time

import openai
from pydantic import BaseModel, Field

from ball_knowledge.config import SETTINGS
from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.enrichment.models import ColumnSpec, EnrichmentRubric

_NAME_RE = re.compile(r"[^a-z0-9_]+")


class _EnrichmentColumn(BaseModel):
    name: str = Field(description="Short snake_case column name, e.g. 'has_placebo_arm', 'biomarker_primary_endpoint'")
    instructions: str = Field(description="The yes/no question to ask about one trial, in Jev's second person framing ('Does this trial...')")
    true_description: str = Field(description="What makes the answer true, specific enough to judge from title/summary/eligibility text")
    false_description: str = Field(description="What makes the answer false")
    weight: float = Field(default=1.0, description="Relative importance of this column for ranking, > 0; higher = more influence on the bonus score")


class _EnrichmentRubricResponse(BaseModel):
    columns: list[_EnrichmentColumn] = Field(description="3-8 independent, narrowly-scoped yes/no columns that together separate strong from weak candidates for this ask")


RUBRIC_COMPILE_INSTRUCTIONS = (
    "You turn a clinical trial researcher's free-text rubric into a small set of "
    "independent yes/no columns to compute over every trial in a database, so "
    "trials can be ranked and filtered on properties beyond a keyword match. Each "
    "column must be answerable from a trial's title, conditions, summary, "
    "description, and eligibility text alone - never assume access to a specific "
    "patient. Keep columns narrowly scoped and independent of each other (e.g. "
    "split 'randomized double-blind placebo-controlled' into separate columns "
    "rather than one compound one) so each contributes distinct signal. Favor "
    "properties that meaningfully separate strong candidates from weak ones for "
    "the stated goal, not properties nearly every trial in scope would share."
)


def _normalize_name(name: str, index: int, seen: set[str]) -> str:
    normalized = _NAME_RE.sub("_", name.strip().lower()).strip("_") or f"column_{index}"
    candidate = normalized
    suffix = 2
    while candidate in seen:
        candidate = f"{normalized}_{suffix}"
        suffix += 1
    seen.add(candidate)
    return candidate


async def compile_enrichment_rubric(
    client: openai.AsyncOpenAI,
    prompt: str,
    receipt: Receipt,
    *,
    model: str | None = None,
) -> EnrichmentRubric:
    model = model or SETTINGS.openai_model
    start = time.perf_counter()
    response = await client.responses.parse(
        model=model,
        instructions=RUBRIC_COMPILE_INSTRUCTIONS,
        input=prompt,
        text_format=_EnrichmentRubricResponse,
        reasoning={"effort": "medium"},
    )
    receipt.record_llm(
        "enrichment_rubric_compile", model, response.usage.input_tokens, response.usage.output_tokens, time.perf_counter() - start
    )

    seen: set[str] = set()
    columns = [
        ColumnSpec(
            name=_normalize_name(c.name, i, seen),
            instructions=c.instructions,
            true_description=c.true_description,
            false_description=c.false_description,
            weight=c.weight if c.weight > 0 else 1.0,
        )
        for i, c in enumerate(response.output_parsed.columns)
    ]
    return EnrichmentRubric(prompt=prompt, columns=columns)
