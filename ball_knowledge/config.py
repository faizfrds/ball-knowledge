"""Environment configuration and pricing constants.

Token counts in the cost receipt come straight off API responses and are always
accurate. Dollar figures require per-token prices, which are looked up here from
environment variables. OpenAI's published standard-tier rates are filled in as
defaults; Jev is priced at $0.042 per million input tokens with output tokens
free, which is also the default here (override with ``TYPESAFE_INPUT_PRICE_PER_MTOK``
if TypeSafe's pricing changes or your account has a different rate). Any dollar
figure that depends on a price that's still unset is reported as unavailable
rather than guessed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _float_env(name: str) -> float | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    return float(raw)


# OpenAI standard-tier list prices, $ per million tokens (developers.openai.com/api/docs/pricing).
OPENAI_PRICING_PER_MTOK: dict[str, tuple[float, float]] = {
    "gpt-5.5": (5.00, 30.00),
    "gpt-5.4": (2.50, 15.00),
    "gpt-5.4-mini": (0.75, 4.50),
    "gpt-5.4-nano": (0.20, 1.25),
    "gpt-5": (1.25, 10.00),
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5-nano": (0.05, 0.40),
}


@dataclass(frozen=True)
class Settings:
    typesafe_api_key: str | None = field(default_factory=lambda: os.environ.get("TYPESAFE_API_KEY"))
    typesafe_model: str = field(default_factory=lambda: os.environ.get("TYPESAFE_MODEL", "jev-latest"))
    # Jev's published rate: $0.042/million input tokens, output tokens are free.
    typesafe_input_price_per_mtok: float | None = field(
        default_factory=lambda: _float_env("TYPESAFE_INPUT_PRICE_PER_MTOK") or 0.042
    )

    openai_api_key: str | None = field(default_factory=lambda: os.environ.get("OPENAI_API_KEY"))
    # Model used for Ball Knowledge's own O(1)-per-query LLM calls: patient extraction,
    # the top-10 explanation, and the design-query parser.
    openai_model: str = field(default_factory=lambda: os.environ.get("OPENAI_MODEL", "gpt-5.5"))
    # Model used for the "LLM-only, same rubric" baseline, which calls the LLM once
    # per candidate trial. Defaults to the same model so the baseline comparison is
    # apples-to-apples; override independently if you want a cheaper baseline.
    openai_baseline_model: str = field(
        default_factory=lambda: os.environ.get("OPENAI_BASELINE_MODEL", "gpt-5.5")
    )
    # Model used for the hybrid-search embedding index (retrieval/embeddings.py).
    openai_embedding_model: str = field(
        default_factory=lambda: os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
    )

    # Gate/criteria-check concurrency against the TypeSafe API.
    jev_concurrency: int = field(default_factory=lambda: int(os.environ.get("JEV_CONCURRENCY", "24")))

    # Optional: only needed for the "hybrid + rerank" baseline in the eval harness.
    cohere_api_key: str | None = field(default_factory=lambda: os.environ.get("COHERE_API_KEY"))
    cohere_rerank_model: str = field(default_factory=lambda: os.environ.get("COHERE_RERANK_MODEL", "rerank-english-v3.0"))
    # Cohere prices rerank per search unit (1 unit = up to 100 docs reranked for one query); not published
    # here as a hard number - set from your Cohere pricing page to populate the baseline's $/query.
    cohere_price_per_1k_search_units: float | None = field(
        default_factory=lambda: _float_env("COHERE_PRICE_PER_1K_SEARCH_UNITS")
    )

    def openai_price_per_mtok(self, model: str | None = None) -> tuple[float, float] | None:
        return OPENAI_PRICING_PER_MTOK.get(model or self.openai_model)


SETTINGS = Settings()
