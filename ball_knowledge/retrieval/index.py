"""A hybrid BM25 + embedding index over the trial registry, built once and reused
across queries and (for the eval harness) across baseline systems.

Search takes an optional boolean `candidate_mask` so the code-side prefilter
(age/sex/recruiting-status, or phase/status/condition for the design-benchmark
demo) can run first and restrict what search ranks - matching the pipeline's
"filter, then search" order rather than searching everything and filtering after.

Combination method: reciprocal rank fusion (RRF) between the BM25 ranking and the
embedding-cosine ranking. RRF needs no score normalization between the two very
differently-scaled signals, which is why it's the standard choice for this kind of
combination.
"""

from __future__ import annotations

import json
import pickle
import re
from pathlib import Path

import numpy as np
from rank_bm25 import BM25Okapi

from ball_knowledge.models import Trial
from ball_knowledge.retrieval import embeddings as emb

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


def embedding_text(trial: Trial) -> str:
    """A short, topical representation for semantic search: title, conditions, and
    the brief summary. Eligibility/detailed-description text is deliberately left
    out here - it's noisy for topical relevance and gets checked criterion-by-
    criterion later in the pipeline."""
    parts = [trial.title, "Conditions: " + ", ".join(trial.conditions), trial.brief_summary]
    return ". ".join(p for p in parts if p)[:2000]


def bm25_text(trial: Trial) -> str:
    return trial.search_text()[:4000]


def _rrf_ranks(sub_scores: np.ndarray) -> np.ndarray:
    """Rank (0 = best) of each entry in a candidate-aligned score array."""
    order = np.argsort(-sub_scores)
    ranks = np.empty_like(order)
    ranks[order] = np.arange(len(order))
    return ranks


class TrialIndex:
    def __init__(self, trials: list[Trial]):
        self.trials = trials
        self.nct_ids = [t.nct_id for t in trials]
        self._bm25: BM25Okapi | None = None
        self._doc_embeddings: np.ndarray | None = None
        self._embedding_model: str | None = None

    # -- building ------------------------------------------------------

    def build_bm25(self) -> None:
        corpus = [tokenize(bm25_text(t)) for t in self.trials]
        self._bm25 = BM25Okapi(corpus)

    def build_embeddings(
        self, *, model_name: str = emb.DEFAULT_MODEL, batch_size: int = 256, show_progress: bool = True
    ) -> None:
        texts = [embedding_text(t) for t in self.trials]
        self._doc_embeddings = emb.encode(texts, model_name=model_name, batch_size=batch_size, show_progress=show_progress)
        self._embedding_model = model_name

    @property
    def has_bm25(self) -> bool:
        return self._bm25 is not None

    @property
    def has_embeddings(self) -> bool:
        return self._doc_embeddings is not None

    # -- persistence -----------------------------------------------------

    def save(self, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "nct_ids.json").write_text(json.dumps(self.nct_ids))
        if self._bm25 is not None:
            with (out_dir / "bm25.pkl").open("wb") as f:
                pickle.dump(self._bm25, f)
        if self._doc_embeddings is not None:
            np.save(out_dir / "embeddings.npy", self._doc_embeddings)
            (out_dir / "embedding_model.txt").write_text(self._embedding_model or "")

    @classmethod
    def load(cls, out_dir: Path, trials: list[Trial]) -> "TrialIndex":
        saved_ids = json.loads((out_dir / "nct_ids.json").read_text())
        if saved_ids != [t.nct_id for t in trials]:
            # A common case: the index was built with `--limit N` (e.g. for a fast
            # smoke test) over the same corpus cache a caller now loads in full.
            # Corpus order is stable, so the saved ids are then an exact prefix -
            # slice down to match rather than forcing a full, slow rebuild.
            if saved_ids == [t.nct_id for t in trials[: len(saved_ids)]]:
                trials = trials[: len(saved_ids)]
            else:
                raise ValueError("Index was built over a different/differently-ordered trial list; rebuild it.")
        idx = cls(trials)
        bm25_path = out_dir / "bm25.pkl"
        if bm25_path.exists():
            with bm25_path.open("rb") as f:
                idx._bm25 = pickle.load(f)
        emb_path = out_dir / "embeddings.npy"
        if emb_path.exists():
            idx._doc_embeddings = np.load(emb_path)
            idx._embedding_model = (out_dir / "embedding_model.txt").read_text().strip() or None
        return idx

    # -- search ------------------------------------------------------

    def search(
        self,
        query_text: str,
        *,
        k: int = 20000,
        candidate_mask: np.ndarray | None = None,
        rrf_k: int = 60,
        use_bm25: bool = True,
        use_embeddings: bool = True,
    ) -> list[tuple[int, float]]:
        """Returns [(position, rrf_score), ...] sorted descending; positions index
        into `self.trials`/`self.nct_ids`."""
        n = len(self.trials)
        candidate_positions = np.flatnonzero(candidate_mask) if candidate_mask is not None else np.arange(n)
        if candidate_positions.size == 0:
            return []

        rrf_scores = np.zeros(n, dtype=np.float64)
        ranked_by_anything = False

        if use_bm25 and self._bm25 is not None:
            full_bm25 = self._bm25.get_scores(tokenize(query_text))
            ranks = _rrf_ranks(full_bm25[candidate_positions])
            rrf_scores[candidate_positions] += 1.0 / (rrf_k + ranks + 1)
            ranked_by_anything = True

        if use_embeddings and self.has_embeddings:
            query_vec = emb.encode([query_text], model_name=self._embedding_model or emb.DEFAULT_MODEL)[0]
            sub_cos = self._doc_embeddings[candidate_positions] @ query_vec
            ranks = _rrf_ranks(sub_cos)
            rrf_scores[candidate_positions] += 1.0 / (rrf_k + ranks + 1)
            ranked_by_anything = True

        if not ranked_by_anything:
            raise RuntimeError(
                "Nothing to rank with: index has no BM25/embeddings built, or both were disabled for this search."
            )

        candidate_scores = rrf_scores[candidate_positions]
        order = np.argsort(-candidate_scores)[:k]
        top_positions = candidate_positions[order]
        return [(int(p), float(rrf_scores[p])) for p in top_positions]
