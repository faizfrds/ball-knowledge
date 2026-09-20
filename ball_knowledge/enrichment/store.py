"""The persistent, appendable column store the crawler writes to and ranking
reads from: `{nct_id: {column_name: probability}}`, plus the `ColumnSpec` each
column was computed from (kept for provenance and so a rerun can tell which
columns already exist).

Two files per store directory, both additive across runs:

- `columns.json` - one ColumnSpec per known column name.
- `values.jsonl.gz` - one line per trial: `{"nct_id": ..., "values": {...}}`.

A later run against the same directory adds new columns for new rubric asks
without touching or requiring a rebuild of earlier ones - that's what makes
this a database layer that "systematically appends columns" rather than a
one-shot report.
"""

from __future__ import annotations

import gzip
import json
from dataclasses import asdict
from pathlib import Path

from ball_knowledge.enrichment.models import ColumnSpec

_COLUMNS_FILE = "columns.json"
_VALUES_FILE = "values.jsonl.gz"


class EnrichmentStore:
    def __init__(self) -> None:
        self._columns: dict[str, ColumnSpec] = {}
        self._values: dict[str, dict[str, float]] = {}

    # -- columns ---------------------------------------------------------

    def register_columns(self, columns: list[ColumnSpec]) -> None:
        """Adds (or, by name, replaces the spec of) columns the crawler is about
        to compute. Registering a column doesn't itself populate any values."""
        for col in columns:
            self._columns[col.name] = col

    @property
    def columns(self) -> list[ColumnSpec]:
        return list(self._columns.values())

    def column_names(self) -> list[str]:
        return list(self._columns.keys())

    # -- values ------------------------------------------------------------

    def has(self, nct_id: str, column: str) -> bool:
        return column in self._values.get(nct_id, {})

    def missing_columns(self, nct_id: str, columns: list[str]) -> list[str]:
        have = self._values.get(nct_id, {})
        return [c for c in columns if c not in have]

    def set(self, nct_id: str, column: str, value: float) -> None:
        self._values.setdefault(nct_id, {})[column] = value

    def get(self, nct_id: str) -> dict[str, float]:
        return dict(self._values.get(nct_id, {}))

    def weighted_bonus(self, nct_id: str) -> float | None:
        """Weighted average of every computed column's probability for this
        trial - the single scalar fed into the rank score's bonus term. `None`
        (not 0.0) when the trial hasn't been enriched yet, so callers can leave
        un-enriched trials' scores untouched rather than penalizing them for
        missing data the crawler simply hasn't reached yet."""
        values = self._values.get(nct_id)
        if not values:
            return None
        total_weight = 0.0
        total = 0.0
        for name, prob in values.items():
            weight = self._columns[name].weight if name in self._columns else 1.0
            total += weight * prob
            total_weight += weight
        return total / total_weight if total_weight else None

    def __len__(self) -> int:
        return len(self._values)

    # -- persistence -------------------------------------------------------

    def save(self, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / _COLUMNS_FILE).write_text(json.dumps({name: asdict(spec) for name, spec in self._columns.items()}, indent=2))
        with gzip.open(out_dir / _VALUES_FILE, "wt", encoding="utf-8") as f:
            for nct_id, values in self._values.items():
                f.write(json.dumps({"nct_id": nct_id, "values": values}) + "\n")

    @classmethod
    def load(cls, out_dir: Path) -> "EnrichmentStore":
        store = cls()
        columns_path = out_dir / _COLUMNS_FILE
        if columns_path.exists():
            raw = json.loads(columns_path.read_text())
            store._columns = {name: ColumnSpec(**spec) for name, spec in raw.items()}
        values_path = out_dir / _VALUES_FILE
        if values_path.exists():
            with gzip.open(values_path, "rt", encoding="utf-8") as f:
                for line in f:
                    row = json.loads(line)
                    store._values[row["nct_id"]] = row["values"]
        return store

    @classmethod
    def load_or_create(cls, out_dir: Path) -> "EnrichmentStore":
        if (out_dir / _COLUMNS_FILE).exists() or (out_dir / _VALUES_FILE).exists():
            return cls.load(out_dir)
        return cls()
