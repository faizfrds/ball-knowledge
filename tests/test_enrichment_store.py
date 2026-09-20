from __future__ import annotations

from pathlib import Path

from ball_knowledge.enrichment.models import ColumnSpec
from ball_knowledge.enrichment.store import EnrichmentStore


def _column(name: str, weight: float = 1.0) -> ColumnSpec:
    return ColumnSpec(name=name, instructions=f"Does this trial have {name}?", true_description="yes", false_description="no", weight=weight)


class TestEnrichmentStore:
    def test_set_and_get_roundtrip(self):
        store = EnrichmentStore()
        store.register_columns([_column("has_placebo_arm")])
        store.set("NCT001", "has_placebo_arm", 0.9)
        assert store.get("NCT001") == {"has_placebo_arm": 0.9}
        assert store.has("NCT001", "has_placebo_arm")
        assert not store.has("NCT001", "other_column")

    def test_missing_columns_reports_only_unset_ones(self):
        store = EnrichmentStore()
        store.set("NCT001", "col_a", 0.5)
        assert store.missing_columns("NCT001", ["col_a", "col_b"]) == ["col_b"]
        assert store.missing_columns("NCT002", ["col_a", "col_b"]) == ["col_a", "col_b"]

    def test_weighted_bonus_averages_by_column_weight(self):
        store = EnrichmentStore()
        store.register_columns([_column("col_a", weight=1.0), _column("col_b", weight=3.0)])
        store.set("NCT001", "col_a", 1.0)
        store.set("NCT001", "col_b", 0.0)
        # (1.0*1.0 + 0.0*3.0) / (1.0+3.0) = 0.25
        assert store.weighted_bonus("NCT001") == 0.25

    def test_weighted_bonus_is_none_for_unenriched_trial(self):
        store = EnrichmentStore()
        assert store.weighted_bonus("NCT999") is None

    def test_save_and_load_roundtrip(self, tmp_path: Path):
        store = EnrichmentStore()
        store.register_columns([_column("has_placebo_arm", weight=2.0)])
        store.set("NCT001", "has_placebo_arm", 0.75)
        store.set("NCT002", "has_placebo_arm", 0.1)
        store.save(tmp_path)

        loaded = EnrichmentStore.load(tmp_path)
        assert loaded.column_names() == ["has_placebo_arm"]
        assert loaded.get("NCT001") == {"has_placebo_arm": 0.75}
        assert loaded.get("NCT002") == {"has_placebo_arm": 0.1}
        assert loaded.columns[0].weight == 2.0

    def test_load_or_create_returns_empty_store_when_no_files_exist(self, tmp_path: Path):
        store = EnrichmentStore.load_or_create(tmp_path / "does_not_exist_yet")
        assert len(store) == 0
        assert store.column_names() == []

    def test_load_or_create_loads_existing_store(self, tmp_path: Path):
        store = EnrichmentStore()
        store.register_columns([_column("col_a")])
        store.set("NCT001", "col_a", 0.3)
        store.save(tmp_path)

        reloaded = EnrichmentStore.load_or_create(tmp_path)
        assert reloaded.get("NCT001") == {"col_a": 0.3}
