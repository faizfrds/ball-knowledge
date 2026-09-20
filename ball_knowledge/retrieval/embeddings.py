"""OpenAI embeddings for the hybrid-search half of retrieval.

Uses the Embeddings API (`text-embedding-3-small` by default, $0.02/1M input
tokens) rather than a local model - no local ML stack (PyTorch etc.) to get
right, and it's cheap: embedding the full ~375k-trial registry once costs well
under $1. Vectors are L2-normalized so a plain dot product gives cosine
similarity.
"""

from __future__ import annotations

import re
import time

import numpy as np
import openai

from ball_knowledge.config import SETTINGS

DEFAULT_MODEL = SETTINGS.openai_embedding_model

_client: openai.OpenAI | None = None

_RETRY_AFTER_RE = re.compile(r"try again in ([\d.]+)s", re.IGNORECASE)


def _get_client() -> openai.OpenAI:
    global _client
    if _client is None:
        _client = openai.OpenAI(api_key=SETTINGS.openai_api_key)
    return _client


def _normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vectors / norms


def _embed_batch_with_retry(client: openai.OpenAI, batch: list[str], model_name: str, max_retries: int = 8):
    """The embeddings TPM limit is org-wide and shared with every other caller, so
    bumping into it mid-run is normal, not exceptional - retry with the server's
    own suggested wait (parsed from the 429 message) instead of failing the whole
    index build over a transient cap."""
    for attempt in range(max_retries):
        try:
            return client.embeddings.create(input=batch, model=model_name)
        except openai.RateLimitError as exc:
            if attempt == max_retries - 1:
                raise
            match = _RETRY_AFTER_RE.search(str(exc))
            wait_s = float(match.group(1)) if match else min(2**attempt, 30)
            time.sleep(wait_s + 0.5)
    raise RuntimeError("unreachable")  # pragma: no cover


def encode(
    texts: list[str], *, model_name: str = DEFAULT_MODEL, batch_size: int = 512, show_progress: bool = False
) -> np.ndarray:
    """Returns an [N, D] float32 array, L2-normalized so dot product == cosine similarity."""
    client = _get_client()
    vectors: list[list[float]] = []
    for start in range(0, len(texts), batch_size):
        batch = texts[start : start + batch_size]
        response = _embed_batch_with_retry(client, batch, model_name)
        vectors.extend(e.embedding for e in response.data)
        if show_progress:
            print(f"\r  embedded {min(start + batch_size, len(texts))}/{len(texts)}", end="", flush=True)
    if show_progress:
        print()
    return _normalize(np.array(vectors, dtype=np.float32))
