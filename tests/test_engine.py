from __future__ import annotations

import pytest

from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.engine import (
    apply_filter_with_guard,
    compute_composite_rank_score,
    compute_geometric_mean,
)


def test_geometric_mean_avoids_decay_bug():
    # Three independent gates at 0.7 multiply to 0.343 and fail a 0.5 threshold,
    # but geometric mean keeps it at 0.7:
    probs = [0.7, 0.7, 0.7]
    g_mean = compute_geometric_mean(probs)
    assert g_mean == pytest.approx(0.7)


def test_geometric_mean_zeroes_on_any_zero():
    assert compute_geometric_mean([0.9, 0.0, 0.8]) == 0.0


def test_geometric_mean_empty():
    assert compute_geometric_mean([]) == 1.0


def test_composite_rank_score_formula():
    # score = G * (0.4 + 0.6 * S) + 0.1 * B
    g, s, b = 0.8, 0.5, 0.2
    expected = 0.8 * (0.4 + 0.6 * 0.5) + 0.1 * 0.2
    assert compute_composite_rank_score(g, s, b) == pytest.approx(expected)


def test_apply_filter_with_guard_drops_when_under_min_pool():
    items = list(range(300))
    # Filter matches only 5 items (< 200)
    filter_fn = lambda x: x < 5
    receipt = Receipt()
    survivors = apply_filter_with_guard(items, filter_fn, receipt, min_pool=200)

    assert receipt.filters_dropped is True
    assert len(survivors) == 300  # full pool restored


def test_apply_filter_with_guard_keeps_when_over_min_pool():
    items = list(range(300))
    # Filter matches 250 items (>= 200)
    filter_fn = lambda x: x < 250
    receipt = Receipt()
    survivors = apply_filter_with_guard(items, filter_fn, receipt, min_pool=200)

    assert receipt.filters_dropped is False
    assert len(survivors) == 250

