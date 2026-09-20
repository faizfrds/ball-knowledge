from __future__ import annotations

import numpy as np
import pytest

from ball_knowledge.retrieval import embeddings as emb
from ball_knowledge.retrieval.index import TrialIndex, bm25_text, embedding_text, tokenize


class TestTokenizeAndTextBuilders:
    def test_tokenize_lowercases_and_strips_punctuation(self):
        assert tokenize("Type-2 Diabetes, Mellitus!") == ["type", "2", "diabetes", "mellitus"]

    def test_embedding_text_excludes_eligibility_and_is_capped(self, diabetes_trial):
        text = embedding_text(diabetes_trial)
        assert diabetes_trial.title in text
        assert "Type 2 Diabetes Mellitus" in text
        assert "Pregnant" not in text  # eligibility text deliberately excluded
        assert len(text) <= 2000

    def test_bm25_text_includes_eligibility(self, diabetes_trial):
        text = bm25_text(diabetes_trial)
        assert "Pregnant" in text


class TestTrialIndexBM25Only:
    def test_search_ranks_relevant_trial_first(self, sample_trials):
        index = TrialIndex(sample_trials)
        index.build_bm25()
        hits = index.search("type 2 diabetes mellitus HbA1c", use_bm25=True, use_embeddings=False)
        assert hits, "expected at least one hit"
        top_position = hits[0][0]
        assert index.nct_ids[top_position] == "NCT00000001"

    def test_search_respects_candidate_mask(self, sample_trials):
        index = TrialIndex(sample_trials)
        index.build_bm25()
        mask = np.array([nct != "NCT00000001" for nct in index.nct_ids])
        hits = index.search("type 2 diabetes mellitus", use_bm25=True, use_embeddings=False, candidate_mask=mask)
        returned_ids = {index.nct_ids[pos] for pos, _ in hits}
        assert "NCT00000001" not in returned_ids

    def test_empty_candidate_mask_returns_no_hits(self, sample_trials):
        index = TrialIndex(sample_trials)
        index.build_bm25()
        mask = np.zeros(len(sample_trials), dtype=bool)
        assert index.search("diabetes", candidate_mask=mask) == []

    def test_search_without_any_built_index_raises(self, sample_trials):
        index = TrialIndex(sample_trials)
        with pytest.raises(RuntimeError):
            index.search("diabetes")

    def test_save_and_load_roundtrip(self, sample_trials, tmp_path):
        index = TrialIndex(sample_trials)
        index.build_bm25()
        index.save(tmp_path)

        loaded = TrialIndex.load(tmp_path, sample_trials)
        assert loaded.has_bm25
        assert not loaded.has_embeddings
        hits = loaded.search("type 2 diabetes", use_bm25=True, use_embeddings=False)
        assert index.nct_ids[hits[0][0]] == "NCT00000001"

    def test_load_rejects_mismatched_trial_list(self, sample_trials, tmp_path):
        index = TrialIndex(sample_trials)
        index.build_bm25()
        index.save(tmp_path)

        with pytest.raises(ValueError):
            TrialIndex.load(tmp_path, list(reversed(sample_trials)))

    def test_load_slices_down_when_index_built_with_a_limit(self, sample_trials, tmp_path):
        """`scripts/build_index.py --limit N` builds over a prefix of the corpus
        cache; loading against the full (unlimited) cache must slice down to that
        same prefix instead of raising, since corpus order is stable."""
        limited = sample_trials[:2]
        index = TrialIndex(limited)
        index.build_bm25()
        index.save(tmp_path)

        loaded = TrialIndex.load(tmp_path, sample_trials)  # full, unlimited corpus
        assert loaded.nct_ids == [t.nct_id for t in limited]
        assert loaded.has_bm25


class TestTrialIndexHybridSearch(object):
    """Embeddings are monkeypatched to deterministic unit vectors so this doesn't
    download a real sentence-transformers model."""

    _VOCAB = ["diabetes", "mellitus", "cancer", "breast", "asthma", "pediatric"]

    @classmethod
    def _fake_encode(cls, texts: list[str], *, model_name: str = emb.DEFAULT_MODEL, batch_size: int = 256, show_progress: bool = False) -> np.ndarray:
        # A tiny deterministic bag-of-words embedding over a fixed vocabulary -
        # unlike a hash-based stub, cosine similarity actually tracks topical
        # overlap, so this exercises RRF fusion the same way a real embedding
        # model would rather than injecting noise uncorrelated with BM25.
        out = np.zeros((len(texts), len(cls._VOCAB)), dtype=np.float32)
        for i, text in enumerate(texts):
            lowered = text.lower()
            counts = np.array([lowered.count(word) for word in cls._VOCAB], dtype=np.float32) + 0.01
            out[i] = counts / np.linalg.norm(counts)
        return out

    def test_hybrid_search_combines_bm25_and_embeddings_via_rrf(self, sample_trials, monkeypatch):
        monkeypatch.setattr(emb, "encode", self._fake_encode)
        index = TrialIndex(sample_trials)
        index.build_bm25()
        index.build_embeddings(show_progress=False)

        assert index.has_embeddings
        hits = index.search("type 2 diabetes mellitus", use_bm25=True, use_embeddings=True)
        assert index.nct_ids[hits[0][0]] == "NCT00000001"
        # every trial should have a nonzero fused score when both signals rank it
        assert all(score > 0 for _pos, score in hits)

    def test_save_and_load_preserves_embeddings(self, sample_trials, monkeypatch, tmp_path):
        monkeypatch.setattr(emb, "encode", self._fake_encode)
        index = TrialIndex(sample_trials)
        index.build_embeddings(show_progress=False)
        index.save(tmp_path)

        loaded = TrialIndex.load(tmp_path, sample_trials)
        assert loaded.has_embeddings
        assert not loaded.has_bm25
