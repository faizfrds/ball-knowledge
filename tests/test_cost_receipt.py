import dataclasses

from ball_knowledge.cost_receipt import Receipt


def test_receipt_with_no_calls_costs_zero():
    receipt = Receipt()
    totals = receipt.totals()
    assert totals.llm_tokens == 0
    assert totals.jev_tokens == 0
    assert totals.llm_cost_usd == 0.0
    assert totals.jev_cost_usd == 0.0
    assert totals.total_cost_usd == 0.0


def test_receipt_llm_cost_uses_known_pricing():
    receipt = Receipt()
    receipt.record_llm("extract", "gpt-5.5", input_tokens=1_000_000, output_tokens=1_000_000, latency_s=1.0)
    totals = receipt.totals()
    assert totals.llm_cost_usd == 5.00 + 30.00
    assert totals.jev_cost_usd == 0.0  # no Jev calls happened - this is a known zero, not an unknown
    assert totals.total_cost_usd == 35.00


def test_receipt_jev_cost_is_unknown_without_pricing_not_silently_zero(monkeypatch):
    import ball_knowledge.cost_receipt as cost_receipt_module

    monkeypatch.setattr(
        cost_receipt_module, "SETTINGS", dataclasses.replace(cost_receipt_module.SETTINGS, typesafe_input_price_per_mtok=None)
    )
    receipt = Receipt()
    receipt.record_llm("extract", "gpt-5.5", input_tokens=1000, output_tokens=1000, latency_s=1.0)
    receipt.record_jev("gate", "jev-latest", input_tokens=500, output_tokens=100, latency_s=0.1)
    totals = receipt.totals()

    assert totals.jev_cost_usd is None  # real calls happened but price is unset - must not read as $0
    assert totals.llm_cost_usd is not None
    # Total must not silently drop the unknown Jev cost and report only the LLM portion.
    assert totals.total_cost_usd is None


def test_receipt_jev_cost_with_pricing_set(monkeypatch):
    import ball_knowledge.cost_receipt as cost_receipt_module

    monkeypatch.setattr(
        cost_receipt_module, "SETTINGS", dataclasses.replace(cost_receipt_module.SETTINGS, typesafe_input_price_per_mtok=1.0)
    )
    receipt = Receipt()
    receipt.record_jev("gate", "jev-latest", input_tokens=1_000_000, output_tokens=500_000, latency_s=1.0)
    totals = receipt.totals()
    # Output tokens are free of charge per the TypeSafe API, so only input tokens are priced.
    assert totals.jev_cost_usd == 1.0
    assert totals.total_cost_usd == 1.0


def test_receipt_unknown_llm_model_pricing_is_none():
    receipt = Receipt()
    receipt.record_llm("extract", "some-future-model", input_tokens=1000, output_tokens=1000, latency_s=1.0)
    totals = receipt.totals()
    assert totals.llm_cost_usd is None
    assert totals.total_cost_usd is None


def test_receipt_other_cost_unpriced_call_is_unknown_not_zero():
    receipt = Receipt()
    receipt.record_other_cost(None)  # a rerank call happened but couldn't be priced
    totals = receipt.totals()
    assert totals.other_cost_usd is None
    assert totals.total_cost_usd is None


def test_receipt_other_cost_priced_call_sums_normally():
    receipt = Receipt()
    receipt.record_other_cost(0.02)
    totals = receipt.totals()
    assert totals.other_cost_usd == 0.02
    assert totals.total_cost_usd == 0.02


def test_time_to_first_result_is_none_until_marked():
    receipt = Receipt()
    assert receipt.totals().time_to_first_result_s is None
    receipt.mark_first_result()
    assert receipt.totals().time_to_first_result_s is not None
