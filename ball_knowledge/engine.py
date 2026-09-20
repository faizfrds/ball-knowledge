"""The 7-stage Ball Knowledge core engine.

No model ever reads the pile. The LLM sees the query and, at the end, 20 titles.
Jev sees one item at a time. Code does every count, threshold, and sort. Context
size therefore never grows with corpus size.

The 7 stages:
1. Compile — one LLM call (query + schema -> JSON rubric: filters, phrasings, gates, scores, bonuses, tags, weights).
2. Filter — structured filters with MIN_POOL = 200 guard (drops filters if pool < 200).
3. Retrieve — multi-phrasing BM25 + dense cosine search, fused via RRF (K_RRF = 60).
4. Gate — Jev Noul must-haves combined with geometric mean (with fallback to top-600 if < 10 survive).
5. Score — full rubric on survivors only (capped at 600).
6. Rank — score = G * (0.4 + 0.6 * S) + 0.1 * B.
7. Explain + receipt — writes reasons per top result + receipt logging requests, tokens, dollars, per-stage seconds, gate_relaxed, filters_dropped.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from ball_knowledge.cost_receipt import Receipt
from ball_knowledge.retrieval.index import TrialIndex, tokenize, _rrf_ranks


MIN_POOL = 200
K_RRF = 60
GATE_SURVIVOR_MIN = 10
GATE_RELAXED_TOP_N = 600
SCORE_CAP = 600


@dataclass
class CompiledRubric:
    filters: dict[str, Any] = field(default_factory=dict)
    phrasings: list[str] = field(default_factory=list)
    gates: list[dict[str, str]] = field(default_factory=list)      # [{name, question, instruction}]
    scores: list[dict[str, Any]] = field(default_factory=list)    # [{name, levels, weight}]
    bonuses: list[dict[str, str]] = field(default_factory=list)   # [{name, question}]
    tags: list[dict[str, Any]] = field(default_factory=list)
    weights: dict[str, float] = field(default_factory=dict)


def compute_geometric_mean(probabilities: list[float]) -> float:
    """Computes geometric mean of probabilities.
    Three independent gates at 0.7 multiply to 0.34 and fail a 0.5 threshold,
    rejecting a document that satisfies every gate well. Geometric mean keeps
    'all must hold' without penalizing a document for having more criteria.
    """
    if not probabilities:
        return 1.0
    if any(p <= 0.0 for p in probabilities):
        return 0.0
    log_sum = sum(math.log(p) for p in probabilities)
    return math.exp(log_sum / len(probabilities))


def compute_composite_rank_score(
    gate_prob: float,
    normalized_score: float = 0.0,
    max_bonus_prob: float = 0.0,
) -> float:
    """score = G * (0.4 + 0.6 * S) + 0.1 * B"""
    return gate_prob * (0.4 + 0.6 * normalized_score) + 0.1 * max_bonus_prob


def fuse_multi_phrasing_rrf(
    index: TrialIndex,
    phrasings: list[str],
    candidate_positions: np.ndarray,
    *,
    k: int = 3000,
    k_rrf: int = K_RRF,
    use_bm25: bool = True,
    use_embeddings: bool = True,
) -> list[tuple[int, float]]:
    """Fuses multi-phrasing BM25 and dense cosine search via Reciprocal Rank Fusion."""
    if candidate_positions.size == 0 or not phrasings:
        return []

    n = len(index.trials)
    fused_scores = np.zeros(n, dtype=np.float64)

    for phrasing in phrasings:
        if not phrasing.strip():
            continue

        if use_bm25 and index._bm25 is not None:
            full_bm25 = index._bm25.get_scores(tokenize(phrasing))
            ranks = _rrf_ranks(full_bm25[candidate_positions])
            fused_scores[candidate_positions] += 1.0 / (k_rrf + ranks + 1)

        if use_embeddings and index.has_embeddings:
            from ball_knowledge.retrieval import embeddings as emb
            query_vec = emb.encode([phrasing], model_name=index._embedding_model or emb.DEFAULT_MODEL)[0]
            sub_cos = index._doc_embeddings[candidate_positions] @ query_vec
            ranks = _rrf_ranks(sub_cos)
            fused_scores[candidate_positions] += 1.0 / (k_rrf + ranks + 1)

    candidate_scores = fused_scores[candidate_positions]
    order = np.argsort(-candidate_scores)[:k]
    top_positions = candidate_positions[order]
    return [(int(p), float(fused_scores[p])) for p in top_positions]


def apply_filter_with_guard(
    all_items: list[Any],
    filter_fn: Callable[[Any], bool],
    receipt: Receipt,
    min_pool: int = MIN_POOL,
) -> list[int]:
    """Stage 2: Filter with MIN_POOL guard.
    If filters leave < min_pool (200 docs), drop them and record it in the receipt.
    Retrieval over a gutted pool is worse than no filter.
    """
    start = time.perf_counter()
    matching_positions = [i for i, item in enumerate(all_items) if filter_fn(item)]
    
    if len(all_items) >= min_pool and len(matching_positions) < min_pool:
        receipt.filters_dropped = True
        matching_positions = list(range(len(all_items)))
    
    receipt.record_stage_latency("filter", time.perf_counter() - start)
    return matching_positions
