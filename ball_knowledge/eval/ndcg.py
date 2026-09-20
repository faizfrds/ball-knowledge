"""NDCG@10 against TREC-CT-2021 physician judgments, plus the eligible-vs-excluded
accuracy metric the results table reports alongside it.

TREC-CT-2021's qrels use exactly the graded-relevance scale NDCG wants: 2 =
eligible, 1 = excluded, 0 = not relevant - so the raw qrel value is the gain,
with no remapping needed.
"""

from __future__ import annotations

import math

from ball_knowledge.data.trec_ct import Qrel


def qrels_by_topic(qrels: list[Qrel]) -> dict[str, dict[str, int]]:
    by_topic: dict[str, dict[str, int]] = {}
    for qrel in qrels:
        by_topic.setdefault(qrel.topic_id, {})[qrel.nct_id] = qrel.relevance
    return by_topic


def dcg_at_k(relevances: list[int], k: int) -> float:
    return sum((2**rel - 1) / math.log2(i + 2) for i, rel in enumerate(relevances[:k]))


def ndcg_at_k(ranked_doc_ids: list[str], topic_qrels: dict[str, int], k: int = 10) -> float:
    """`ranked_doc_ids` is one system's ranking for one topic, best first."""
    if not topic_qrels:
        return 0.0
    gains = [topic_qrels.get(doc_id, 0) for doc_id in ranked_doc_ids[:k]]
    dcg = dcg_at_k(gains, k)
    ideal_gains = sorted(topic_qrels.values(), reverse=True)
    idcg = dcg_at_k(ideal_gains, k)
    return dcg / idcg if idcg > 0 else 0.0


def eligible_vs_excluded_accuracy(predicted_labels: dict[str, str], topic_qrels: dict[str, int]) -> tuple[int, int]:
    """Among docs judged eligible(2) or excluded(1) that the system also labeled
    (only systems that produce a 3-way label can be scored here - a ranking-only
    baseline like plain BM25 has nothing to compare), returns (correct, total)."""
    correct = 0
    total = 0
    for doc_id, relevance in topic_qrels.items():
        if relevance not in (1, 2):
            continue
        predicted = predicted_labels.get(doc_id)
        if predicted is None:
            continue
        total += 1
        expected = "eligible" if relevance == 2 else "excluded"
        if predicted == expected:
            correct += 1
    return correct, total
