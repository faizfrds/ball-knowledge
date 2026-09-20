"""Splits a trial's free-text eligibility criteria into individual inclusion and
exclusion criteria. ClinicalTrials.gov eligibility text is free-form but usually
follows an "Inclusion Criteria:" / "Exclusion Criteria:" convention with bulleted
or numbered items under each; this handles that convention and a couple of
plausible fallbacks (unbulleted, blank-line-separated paragraphs; a single
unlabeled block, treated as all-inclusion since we can't safely guess otherwise).
"""

from __future__ import annotations

import re

from ball_knowledge.models import Criterion, CriterionKind, Trial

_INCLUSION_HEADER_RE = re.compile(r"inclusion\s+criteria\s*:?", re.IGNORECASE)
_EXCLUSION_HEADER_RE = re.compile(r"exclusion\s+criteria\s*:?", re.IGNORECASE)
_BULLET_RE = re.compile(r"^\s*(?:[-*•‣▪]|\(?\d{1,3}[.):])\s+")


def split_eligibility_text(text: str) -> tuple[list[str], list[str]]:
    """Returns (inclusion_lines, exclusion_lines)."""
    if not text or not text.strip():
        return [], []

    inc_match = _INCLUSION_HEADER_RE.search(text)
    exc_match = _EXCLUSION_HEADER_RE.search(text)

    if inc_match and exc_match:
        if inc_match.start() < exc_match.start():
            inclusion_block = text[inc_match.end() : exc_match.start()]
            exclusion_block = text[exc_match.end() :]
        else:
            exclusion_block = text[exc_match.end() : inc_match.start()]
            inclusion_block = text[inc_match.end() :]
    elif inc_match:
        inclusion_block = text[inc_match.end() :]
        exclusion_block = ""
    elif exc_match:
        exclusion_block = text[exc_match.end() :]
        inclusion_block = text[: exc_match.start()]
    else:
        inclusion_block = text
        exclusion_block = ""

    return _split_block(inclusion_block), _split_block(exclusion_block)


def _split_block(block: str) -> list[str]:
    if not block or not block.strip():
        return []

    lines = block.splitlines()
    bullet_lines = [line for line in lines if _BULLET_RE.match(line)]
    items: list[str] = []

    if len(bullet_lines) >= 2:
        current: str | None = None
        for line in lines:
            if _BULLET_RE.match(line):
                if current is not None:
                    items.append(current)
                current = _BULLET_RE.sub("", line, count=1)
            elif current is not None:
                stripped = line.strip()
                if stripped:
                    current += " " + stripped
        if current is not None:
            items.append(current)
    else:
        paragraph: list[str] = []
        for line in lines:
            stripped = line.strip()
            if not stripped:
                if paragraph:
                    items.append(" ".join(paragraph))
                    paragraph = []
            else:
                paragraph.append(stripped)
        if paragraph:
            items.append(" ".join(paragraph))

    cleaned = []
    for item in items:
        item = re.sub(r"\s+", " ", item).strip(" -\t")
        if len(item) >= 3:
            cleaned.append(item)
    return cleaned


def build_criteria(trial: Trial) -> list[Criterion]:
    inclusion_lines, exclusion_lines = split_eligibility_text(trial.eligibility_criteria_text)
    criteria: list[Criterion] = []
    index = 0
    for line in inclusion_lines:
        criteria.append(Criterion(trial.nct_id, index, CriterionKind.INCLUSION, line))
        index += 1
    for line in exclusion_lines:
        criteria.append(Criterion(trial.nct_id, index, CriterionKind.EXCLUSION, line))
        index += 1
    return criteria
