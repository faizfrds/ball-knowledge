#!/usr/bin/env python3
"""Adapter over TypeSafe's Jev (System One) with the two batching strategies.

The docs are explicit that one request = one state = one set of answers, and that
the *fan-out* pattern means many questions about ONE item. That makes requests per
minute (1,200) the binding limit, not the 250k tokens/s cap:

  per-item mode : 1 request per item      -> 20k items = 20k requests = ~17 min
  packed  mode  : N items per request     -> 20k items /100 = 200 requests = ~10 s

Packed mode puts an array of items in `state` and names one question per
(item, check) pair, e.g. "i07__engaged", instructing Jev to consider only item 7.
The docs permit an "array of text values" as state and say all questions see the
same state, so this is within contract -- but it trades accuracy for throughput,
because every question now reads 100 items' worth of text. validate_packing.py
measures that trade-off instead of assuming it.
"""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Sequence

MODEL = "jev-latest"
MAX_STATE_TOKENS = 32_000   # docs: state + longest question <= 32k
PRICE_PER_MTOK = 0.042      # docs: $0.042 per million input tokens, output free
REQUESTS_PER_MIN = 1_200


@dataclass
class Usage:
    """Running tally for the cost receipt; every response's usage lands here."""
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    latencies: list = field(default_factory=list)   # seconds per request

    @property
    def cost_usd(self) -> float:
        return self.input_tokens / 1_000_000 * PRICE_PER_MTOK

    def add(self, resp: Any) -> None:
        u = getattr(resp, "usage", None)
        self.requests += 1
        self.input_tokens += (getattr(u, "input_tokens", None) or 0)
        self.output_tokens += (getattr(u, "output_tokens", None) or 0)

    def percentile(self, q: float) -> float:
        if not self.latencies:
            return 0.0
        xs = sorted(self.latencies)
        return xs[min(int(q * len(xs)), len(xs) - 1)]

    def as_dict(self) -> dict:
        return {"requests": self.requests, "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens, "cost_usd": round(self.cost_usd, 6),
                "latency_p50": round(self.percentile(0.50), 3),
                "latency_p95": round(self.percentile(0.95), 3)}


@dataclass
class JevClient:
    """Thin wrapper: concurrency, usage accounting, and the two batching modes."""
    api_key: str | None = None
    model: str = MODEL
    workers: int = 16
    usage: Usage = field(default_factory=Usage)
    _client: Any = None
    _lock: Any = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        from typesafe_sdk import RetryPolicy, TypeSafeClient
        key = self.api_key or os.environ.get("TYPESAFE_API_KEY")
        if not key:
            raise RuntimeError(
                "No TYPESAFE_API_KEY. Set it in the environment or pass api_key=."
            )
        # The default policy gives up after 2 tries, which is nowhere near enough for
        # a corpus-wide pass: 429s are routine at 1,200 req/min and are the normal
        # signal to slow down, not an error.
        self._client = TypeSafeClient(
            api_key=key, model=self.model,
            retry=RetryPolicy(max_retries=8, backoff_initial=1.0, backoff_max=30.0,
                              backoff_jitter=0.3, respect_retry_after=True, timeout=120.0),
            timeout=120.0,
        )

    def close(self) -> None:
        if self._client:
            self._client.close()

    def ask(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        """One request: one state, many questions. The documented fan-out shape."""
        t0 = time.perf_counter()
        resp = self._client.system_one(state=state, questions=questions)
        dt = time.perf_counter() - t0
        with self._lock:
            self.usage.add(resp)
            self.usage.latencies.append(dt)
        return resp.answers

    def judge_per_item(
        self, items: Sequence[Any], questions: dict[str, Any],
        on_result: Callable[[int, dict], None] | None = None,
    ) -> list[dict[str, Any]]:
        """Accurate mode: one request per item, fanned out across threads."""
        out: list[dict[str, Any] | None] = [None] * len(items)

        def one(i: int):
            ans = self.ask(items[i], questions)
            out[i] = ans
            if on_result:
                on_result(i, ans)

        with ThreadPoolExecutor(self.workers) as ex:
            list(ex.map(one, range(len(items))))
        return out  # type: ignore[return-value]

    def judge_packed(
        self, items: Sequence[str], questions: dict[str, Any], per_request: int = 100,
        on_result: Callable[[int, dict], None] | None = None,
    ) -> list[dict[str, Any]]:
        """Throughput mode: `per_request` items per call, one question per pair.

        Question keys are "i{local_index:03d}__{qid}" and each question's
        instructions are rewritten to point at that index in the array.
        """
        from typesafe_sdk import Choice, Noul, Score

        out: list[dict[str, Any]] = [{} for _ in items]
        chunks = [(s, list(items[s:s + per_request]))
                  for s in range(0, len(items), per_request)]

        def rewrite(q: Any, idx: int) -> Any:
            pointer = (f"Consider ONLY item number {idx} in the array provided as state "
                       f"(the array is 0-indexed). Ignore every other item. ")
            instr = pointer + (q.instructions or "")
            if isinstance(q, Noul):
                return Noul(instructions=instr, criteria=q.criteria)
            if isinstance(q, Score):
                return Score(instructions=instr, criteria=q.criteria)
            if isinstance(q, Choice):
                return Choice(instructions=instr, criteria=q.criteria)
            raise TypeError(f"unsupported question type: {type(q)}")

        def one(chunk: tuple[int, list[str]]):
            start, batch = chunk
            packed = {f"i{j:03d}__{qid}": rewrite(q, j)
                      for j in range(len(batch)) for qid, q in questions.items()}
            answers = self.ask(batch, packed)
            for key, ans in answers.items():
                j_str, qid = key.split("__", 1)
                gi = start + int(j_str[1:])
                out[gi][qid] = ans
                if on_result:
                    on_result(gi, out[gi])

        with ThreadPoolExecutor(self.workers) as ex:
            list(ex.map(one, chunks))
        return out


def noul(instructions: str, true: str, false: str):
    """A must-have yes/no check. Positive phrasing only; take 1-p in code to negate."""
    from typesafe_sdk import Noul
    return Noul(instructions=instructions, criteria={"true": true, "false": false})


def score(instructions: str, levels: Sequence[str]):
    """A graded preference, lowest level first."""
    from typesafe_sdk import Score
    return Score(instructions=instructions, criteria=list(levels))


def choice(instructions: str, options: dict[str, str]):
    """A category tag for grouping and analysis."""
    from typesafe_sdk import Choice
    return Choice(instructions=instructions, criteria=options)


def p_true(answer: Any) -> float:
    """Probability from a Noul answer, or the normalized score from a Score answer."""
    if hasattr(answer, "noul"):
        return float(answer.noul)
    if hasattr(answer, "score"):
        return float(answer.score)
    return 0.0


def estimate(n_items: int, tokens_per_item: int, per_request: int) -> dict:
    """What a pass over n_items costs and how long the rate limit makes it take."""
    requests = -(-n_items // per_request)
    tokens = n_items * tokens_per_item
    # Each packed question re-reads the whole array, so tokens scale with questions
    # per request; this is the floor, not the ceiling.
    return {
        "items": n_items,
        "requests": requests,
        "input_tokens": tokens,
        "cost_usd": round(tokens / 1e6 * PRICE_PER_MTOK, 4),
        "minutes_at_rate_limit": round(requests / REQUESTS_PER_MIN, 2),
    }
