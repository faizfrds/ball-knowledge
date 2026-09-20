#!/usr/bin/env python3
"""Hybrid retrieval: BM25 over the text, cosine over the embeddings, fused by rank.

At 205k works a brute-force dot product against a float16 matrix is ~100 ms, so
there is no vector database here on purpose -- an ANN index would add a dependency
and an approximation for no measurable win at this size.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

K_RRF = 60  # reciprocal-rank-fusion constant; standard value, not tuned

# Documents and queries must come from the same model. bge-large was measured at
# 1.0 docs/s locally and Modal's free tier preempted faster than it worked, so the
# corpus is embedded with OpenAI's text-embedding-3-small and queries go the same
# way -- one round trip per query, about 100 ms, versus a second of local ONNX.
EMBED_MODEL = "text-embedding-3-small"


@dataclass
class HybridIndex:
    ids: list[str]
    emb: np.ndarray                 # (n, 1536) float16, L2-normalized
    bm25: object | None = None
    _pos: dict[str, int] | None = None

    @classmethod
    def load(cls, processed: str = "data/processed") -> "HybridIndex":
        p = Path(processed)
        ids = json.loads((p / "embed_ids.json").read_text())
        emb = np.load(p / "embeddings.npy")
        fts = p / "fts.duckdb"
        idx = cls(ids=ids, emb=emb, bm25=str(fts) if fts.exists() else None)
        idx._pos = {w: i for i, w in enumerate(ids)}
        return idx

    def embed_query(self, texts: list[str]) -> np.ndarray:
        from openai import OpenAI
        r = OpenAI().embeddings.create(model=EMBED_MODEL, input=texts)
        v = np.asarray([d.embedding for d in r.data], dtype=np.float32)
        v /= (np.linalg.norm(v, axis=1, keepdims=True) + 1e-12)
        return v

    def dense(self, qvecs: np.ndarray, top_k: int) -> list[list[int]]:
        # emb is already normalized, so the dot product is cosine similarity.
        sims = qvecs.astype(np.float16) @ self.emb.T
        out = []
        for row in np.asarray(sims):
            k = min(top_k, row.shape[0])
            part = np.argpartition(-row, k - 1)[:k]
            out.append(part[np.argsort(-row[part])].tolist())
        return out

    def sparse(self, queries: list[str], top_k: int) -> list[list[int]]:
        """BM25 through DuckDB's FTS extension.

        bm25s has no wheel for the Python in use here, and DuckDB ships BM25 scoring
        natively, so the sparse side rides on the database already in the stack
        instead of adding two more dependencies."""
        if self.bm25 is None:
            return [[] for _ in queries]
        import duckdb
        con = duckdb.connect(self.bm25, read_only=True)
        con.execute("LOAD fts")
        out = []
        for q in queries:
            # The tokenizer chokes on punctuation, so reduce the query to words.
            clean = " ".join(w for w in "".join(
                c if c.isalnum() or c.isspace() else " " for c in q).split())
            if not clean:
                out.append([])
                continue
            rows = con.execute("""
                SELECT row_id FROM (
                    SELECT row_id, fts_main_docs.match_bm25(doc_id, ?) AS score
                    FROM docs
                ) WHERE score IS NOT NULL ORDER BY score DESC LIMIT ?""",
                [clean, min(top_k, len(self.ids))]).fetchall()
            out.append([int(r[0]) for r in rows])
        con.close()
        return out

    def search(self, phrasings: list[str], top_k: int = 20_000,
               allow: set[str] | None = None) -> list[str]:
        """Run every phrasing through both retrievers and fuse by reciprocal rank."""
        per = max(top_k, 1000)
        dense = self.dense(self.embed_query(phrasings), per)
        sparse = self.sparse(phrasings, per)
        fused: dict[int, float] = {}
        for ranking in dense + sparse:
            for rank, i in enumerate(ranking):
                fused[i] = fused.get(i, 0.0) + 1.0 / (K_RRF + rank + 1)
        order = sorted(fused, key=fused.get, reverse=True)
        ids = [self.ids[i] for i in order]
        if allow is not None:
            ids = [w for w in ids if w in allow]
        return ids[:top_k]


def build_bm25(processed: str = "data/processed", db: str | None = None) -> None:
    """Build the BM25 index over the same rows, in the same order, as the embeddings.

    row_id is the position in embed_ids.json, so sparse and dense rankings refer to
    the same integer index and can be fused without a lookup table."""
    import duckdb

    p = Path(processed)
    ids = json.loads((p / "embed_ids.json").read_text())
    src = duckdb.connect(db or str(p / "ball.duckdb"), read_only=True)
    rows = dict(src.execute(
        "SELECT work_id, coalesce(title,'') || ' ' || coalesce(abstract,'') "
        "FROM works WHERE abstract IS NOT NULL").fetchall())
    src.close()

    out = p / "fts.duckdb"
    out.unlink(missing_ok=True)
    con = duckdb.connect(str(out))
    con.execute("INSTALL fts; LOAD fts")
    con.execute("CREATE TABLE docs (row_id BIGINT, doc_id VARCHAR, text VARCHAR)")
    con.executemany("INSERT INTO docs VALUES (?, ?, ?)",
                    [(i, w, rows.get(w, "")) for i, w in enumerate(ids)])
    con.execute("PRAGMA create_fts_index('docs', 'doc_id', 'text', overwrite=1)")
    n = con.execute("SELECT count(*) FROM docs").fetchone()[0]
    con.close()
    print(f"BM25/FTS index over {n:,} docs -> {out}")


if __name__ == "__main__":
    build_bm25()
