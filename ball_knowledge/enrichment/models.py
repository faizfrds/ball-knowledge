"""Data structures for one rubric-derived enrichment column: a per-trial Jev
Noul question ("does this trial have property X?") whose calibrated P(true)
becomes a new column in the trial database and a weighted contributor to the
rank score's bonus term."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ColumnSpec:
    """One new database column, derived by asking Jev a yes/no question about
    each trial. `name` is the column key (also the Jev question name)."""

    name: str
    instructions: str
    true_description: str
    false_description: str
    weight: float = 1.0

    def noul_criteria(self) -> dict[str, str]:
        return {"true": self.true_description, "false": self.false_description}


@dataclass
class EnrichmentRubric:
    """The set of columns compiled from one user prompt."""

    prompt: str
    columns: list[ColumnSpec] = field(default_factory=list)
