import math

from ball_knowledge.data.trec_ct import Qrel
from ball_knowledge.eval.ndcg import dcg_at_k, eligible_vs_excluded_accuracy, ndcg_at_k, qrels_by_topic


def test_qrels_by_topic():
    qrels = [Qrel("1", "NCTA", 2), Qrel("1", "NCTB", 0), Qrel("2", "NCTC", 1)]
    grouped = qrels_by_topic(qrels)
    assert grouped == {"1": {"NCTA": 2, "NCTB": 0}, "2": {"NCTC": 1}}


def test_ndcg_perfect_ranking_is_one():
    topic_qrels = {"A": 2, "B": 1, "C": 0}
    assert ndcg_at_k(["A", "B", "C"], topic_qrels, k=10) == 1.0


def test_ndcg_worst_ranking_is_low():
    topic_qrels = {"A": 2, "B": 1, "C": 0}
    worst = ndcg_at_k(["C", "B", "A"], topic_qrels, k=10)
    best = ndcg_at_k(["A", "B", "C"], topic_qrels, k=10)
    assert worst < best
    assert 0.0 <= worst < 1.0


def test_ndcg_empty_qrels_is_zero():
    assert ndcg_at_k(["A", "B"], {}, k=10) == 0.0


def test_ndcg_unjudged_or_unretrieved_docs_contribute_zero_gain():
    topic_qrels = {"A": 2}
    # "A" retrieved but ranked second, behind an unjudged doc "X" - matches
    # standard TREC practice of treating unjudged docs as non-relevant.
    ndcg = ndcg_at_k(["X", "A"], topic_qrels, k=10)
    assert 0.0 < ndcg < 1.0


def test_dcg_matches_manual_formula():
    relevances = [2, 1, 0]
    expected = (2**2 - 1) / math.log2(2) + (2**1 - 1) / math.log2(3) + (2**0 - 1) / math.log2(4)
    assert dcg_at_k(relevances, 10) == expected


def test_eligible_vs_excluded_accuracy():
    topic_qrels = {"A": 2, "B": 1, "C": 0}
    predicted = {"A": "eligible", "B": "eligible", "C": "excluded"}
    correct, total = eligible_vs_excluded_accuracy(predicted, topic_qrels)
    # A: eligible predicted, eligible expected -> correct
    # B: eligible predicted, excluded expected -> wrong
    # C: not_relevant (0) is excluded from this metric entirely
    assert total == 2
    assert correct == 1


def test_eligible_vs_excluded_accuracy_only_counts_labeled_docs():
    topic_qrels = {"A": 2, "B": 1}
    predicted = {"A": "eligible"}  # B was never retrieved/labeled by this system
    correct, total = eligible_vs_excluded_accuracy(predicted, topic_qrels)
    assert total == 1
    assert correct == 1
