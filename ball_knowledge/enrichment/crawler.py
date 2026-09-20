"""The background crawler: walks the trial database and, for every trial
missing one or more of the rubric's columns, fires one Jev call asking all of
its missing Noul questions at once (`run_noul_set_batch` - the "several
independent questions about one shared state in one call" pattern already used
by the design-benchmark demo), then writes each answer's probability into the
`EnrichmentStore` as a new column.

Meant to run as a separate, long-lived process against a large corpus (see
`ball_knowledge.cli`'s `enrich` subcommand) - `checkpoint_every` makes it safe
to interrupt and resume: progress already computed is on disk before the next
chunk starts, so a rerun with the same rubric only fills in what's missing.
"""

from __future__ import annotations

from pathlib import Path

from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.enrichment.models import EnrichmentRubric
from ball_knowledge.enrichment.store import EnrichmentStore
from ball_knowledge.models import Trial
from ball_knowledge.typesafe_client import JevRequest, run_noul_set_batch


def _trial_state(trial: Trial) -> dict:
    return {
        "nct_id": trial.nct_id,
        "title": trial.title,
        "conditions": trial.conditions,
        "phase": trial.phase,
        "study_type": trial.study_type,
        "brief_summary": trial.brief_summary[:2000],
        "detailed_description": trial.detailed_description[:2000],
        "eligibility_criteria": trial.eligibility_criteria_text[:2000],
        "arm_groups": trial.arm_groups,
        "interventions": trial.interventions,
        "outcomes": trial.outcomes,
    }


async def run_enrichment_crawler(
    trials: list[Trial],
    rubric: EnrichmentRubric,
    store: EnrichmentStore,
    receipt: Receipt,
    *,
    concurrency: int | None = None,
    model: str | None = None,
    checkpoint_every: int = 2000,
    checkpoint_dir: Path | None = None,
    on_progress=None,
) -> EnrichmentStore:
    if not rubric.columns:
        return store

    store.register_columns(rubric.columns)
    column_names = [c.name for c in rubric.columns]
    noul_questions = {c.name: (c.instructions, c.noul_criteria()) for c in rubric.columns}

    pending = [t for t in trials if store.missing_columns(t.nct_id, column_names)]
    if not pending:
        return store

    for start in range(0, len(pending), checkpoint_every):
        chunk = pending[start : start + checkpoint_every]
        requests = [
            JevRequest(key=t.nct_id, state={"trial": _trial_state(t)})
            for t in chunk
            if store.missing_columns(t.nct_id, column_names)
        ]
        results = await run_noul_set_batch(
            requests,
            noul_questions,
            receipt,
            label="enrichment",
            concurrency=concurrency,
            model=model,
        )
        for req in requests:
            result = results.get(req.key)
            if result is None or result.error is not None:
                continue
            for name, probability in result.probabilities.items():
                store.set(req.key, name, probability)

        if checkpoint_dir is not None:
            store.save(checkpoint_dir)
        if on_progress is not None:
            on_progress(min(start + checkpoint_every, len(pending)), len(pending))

    return store
