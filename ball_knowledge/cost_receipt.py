"""Tracks tokens, calls, and latency for one pipeline run and turns them into the
"cost receipt" shown in the UI and rolled up into the shared results table.

Token counts are read straight from API responses (`usage.input_tokens` /
`usage.output_tokens`) and are always exact. Dollar figures multiply those counts by
the price constants in `ball_knowledge.config`; where a price isn't known (TypeSafe
does not publish one), the cost field is `None` rather than a guess - callers should
render that as "n/a", not zero.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from ball_knowledge.config import SETTINGS


@dataclass
class CallRecord:
    label: str  # e.g. "patient_extraction", "gate", "criterion_check", "explain_top10"
    model: str
    input_tokens: int
    output_tokens: int
    latency_s: float


@dataclass
class ReceiptTotals:
    llm_input_tokens: int
    llm_output_tokens: int
    jev_input_tokens: int
    jev_output_tokens: int
    llm_calls: int
    jev_calls: int
    wall_clock_s: float
    time_to_first_result_s: float | None
    llm_cost_usd: float | None
    jev_cost_usd: float | None
    other_cost_usd: float | None = None
    gate_relaxed: bool = False
    filters_dropped: bool = False
    stage_latencies_s: dict[str, float] = field(default_factory=dict)

    @property
    def llm_tokens(self) -> int:
        return self.llm_input_tokens + self.llm_output_tokens

    @property
    def jev_tokens(self) -> int:
        return self.jev_input_tokens + self.jev_output_tokens

    @property
    def total_cost_usd(self) -> float | None:
        # Each part is 0.0 when that call type never happened (a known fact) and
        # None only when calls happened but couldn't be priced. So the total is
        # None if *any* part is unpriced - summing with `or 0.0` there would
        # silently under-report a real, just-unpriced cost as zero.
        parts = [self.llm_cost_usd, self.jev_cost_usd, self.other_cost_usd]
        if any(p is None for p in parts):
            return None
        return sum(parts)

    def to_dict(self) -> dict:
        return {
            "llm_input_tokens": self.llm_input_tokens,
            "llm_output_tokens": self.llm_output_tokens,
            "llm_tokens": self.llm_tokens,
            "jev_input_tokens": self.jev_input_tokens,
            "jev_output_tokens": self.jev_output_tokens,
            "jev_tokens": self.jev_tokens,
            "llm_calls": self.llm_calls,
            "jev_calls": self.jev_calls,
            "wall_clock_s": round(self.wall_clock_s, 3),
            "time_to_first_result_s": round(self.time_to_first_result_s, 3)
            if self.time_to_first_result_s is not None
            else None,
            "llm_cost_usd": self.llm_cost_usd,
            "jev_cost_usd": self.jev_cost_usd,
            "other_cost_usd": self.other_cost_usd,
            "total_cost_usd": self.total_cost_usd,
            "gate_relaxed": self.gate_relaxed,
            "filters_dropped": self.filters_dropped,
            "stage_latencies_s": {k: round(v, 3) for k, v in self.stage_latencies_s.items()},
        }


class Receipt:
    """One receipt per pipeline run (one patient query or one design-benchmark query)."""

    def __init__(self) -> None:
        self._llm_calls: list[CallRecord] = []
        self._jev_calls: list[CallRecord] = []
        self._other_costs: list[float | None] = []
        self._started_at = time.perf_counter()
        self._first_result_at: float | None = None
        self.gate_relaxed: bool = False
        self.filters_dropped: bool = False
        self._stage_latencies: dict[str, float] = {}

    def record_stage_latency(self, stage_name: str, duration_s: float) -> None:
        self._stage_latencies[stage_name] = duration_s

    def record_llm(self, label: str, model: str, input_tokens: int, output_tokens: int, latency_s: float) -> None:
        self._llm_calls.append(CallRecord(label, model, input_tokens, output_tokens, latency_s))

    def record_jev(self, label: str, model: str, input_tokens: int, output_tokens: int, latency_s: float) -> None:
        self._jev_calls.append(CallRecord(label, model, input_tokens, output_tokens, latency_s))

    def record_other_cost(self, cost_usd: float | None) -> None:
        """For a non-token-priced call that happened, e.g. a reranker billed per
        search unit. Call this once per such call even when its price can't be
        computed - pass `None` in that case - so a real-but-unpriced cost isn't
        silently reported as free."""
        self._other_costs.append(cost_usd)

    def mark_first_result(self) -> None:
        """Call once, when the first trial the user can act on becomes available
        (e.g. right after the gate stage, before the top-10 explanations finish)."""
        if self._first_result_at is None:
            self._first_result_at = time.perf_counter()

    @property
    def llm_calls(self) -> list[CallRecord]:
        return list(self._llm_calls)

    @property
    def jev_calls(self) -> list[CallRecord]:
        return list(self._jev_calls)

    def _llm_cost(self) -> float | None:
        if not self._llm_calls:
            return 0.0
        total = 0.0
        for call in self._llm_calls:
            pricing = SETTINGS.openai_price_per_mtok(call.model)
            if pricing is None:
                return None  # a call happened but we don't know its price - don't report a partial sum as complete
            price_in, price_out = pricing
            total += call.input_tokens / 1e6 * price_in + call.output_tokens / 1e6 * price_out
        return total

    def _jev_cost(self) -> float | None:
        if not self._jev_calls:
            return 0.0
        price_in = SETTINGS.typesafe_input_price_per_mtok
        if price_in is None:
            return None
        # Output tokens are reported by the API as free of charge.
        return sum(call.input_tokens for call in self._jev_calls) / 1e6 * price_in

    def _other_cost(self) -> float | None:
        if not self._other_costs:
            return 0.0
        if any(c is None for c in self._other_costs):
            return None
        return sum(self._other_costs)

    def totals(self) -> ReceiptTotals:
        now = time.perf_counter()
        return ReceiptTotals(
            llm_input_tokens=sum(c.input_tokens for c in self._llm_calls),
            llm_output_tokens=sum(c.output_tokens for c in self._llm_calls),
            jev_input_tokens=sum(c.input_tokens for c in self._jev_calls),
            jev_output_tokens=sum(c.output_tokens for c in self._jev_calls),
            llm_calls=len(self._llm_calls),
            jev_calls=len(self._jev_calls),
            wall_clock_s=now - self._started_at,
            time_to_first_result_s=(self._first_result_at - self._started_at)
            if self._first_result_at is not None
            else None,
            llm_cost_usd=self._llm_cost(),
            jev_cost_usd=self._jev_cost(),
            other_cost_usd=self._other_cost(),
            gate_relaxed=self.gate_relaxed,
            filters_dropped=self.filters_dropped,
            stage_latencies_s=dict(self._stage_latencies),
        )
