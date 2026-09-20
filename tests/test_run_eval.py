"""Targeted tests for `ball_knowledge.eval.run_eval`'s non-pipeline logic: CLI
defaults and the headline-number/table rendering, which is otherwise only
exercised by actually running the (paid, live) eval harness.
"""

from __future__ import annotations

from ball_knowledge.eval.run_eval import main, render_headline_numbers, render_markdown_table


class TestBkRequireRecruitingDefault:
    def test_defaults_to_false(self, monkeypatch):
        """TREC-CT-2021's ground truth doesn't restrict by current recruitment
        status (most judged-eligible trials in a 2021 snapshot are long since
        Completed) - the eval harness must not apply that production-only
        prefilter unless explicitly asked to, or it silently excludes ~98% of
        its own ground truth before retrieval ever runs. Regression test for
        that exact bug."""
        captured = {}

        async def fake_run(args):
            captured["args"] = args
            return {}

        import ball_knowledge.eval.run_eval as run_eval_module

        monkeypatch.setattr(run_eval_module, "run", fake_run)
        monkeypatch.setattr("sys.argv", ["run_eval.py", "--systems", "bm25"])

        main()

        assert captured["args"].bk_require_recruiting is False

    def test_flag_opts_in_to_recruiting_filter(self, monkeypatch):
        captured = {}

        async def fake_run(args):
            captured["args"] = args
            return {}

        import ball_knowledge.eval.run_eval as run_eval_module

        monkeypatch.setattr(run_eval_module, "run", fake_run)
        monkeypatch.setattr("sys.argv", ["run_eval.py", "--systems", "bm25", "--bk-require-recruiting"])

        main()

        assert captured["args"].bk_require_recruiting is True


class TestRenderMarkdownTable:
    def test_includes_only_systems_present_in_report(self):
        report = {"bm25": {"ndcg10_mean": 0.5, "llm_tokens_per_query": 0, "jev_tokens_per_query": 0}}
        table = render_markdown_table(report)
        assert "Keyword search (BM25)" in table
        assert "Hybrid" not in table
        assert "0.500" in table

    def test_missing_cost_reads_as_not_available(self):
        report = {"bm25": {"ndcg10_mean": 0.1, "llm_tokens_per_query": 0, "jev_tokens_per_query": 0, "cost_usd_per_query": None}}
        table = render_markdown_table(report)
        assert "n/a (set pricing in .env)" in table


class TestRenderHeadlineNumbers:
    def test_computes_accuracy_lift_and_savings(self):
        report = {
            "bm25": {"ndcg10_mean": 0.30},
            "llm_only": {"ndcg10_mean": 0.40, "llm_tokens_per_query": 100_000, "cost_usd_per_query": 5.0, "median_latency_s": 200.0},
            "ball_knowledge": {"ndcg10_mean": 0.45, "llm_tokens_per_query": 1_000, "cost_usd_per_query": 0.5, "median_latency_s": 20.0},
        }
        text = render_headline_numbers(report)
        assert "vs Keyword search (BM25): +0.150" in text
        assert "vs LLM-only, same rubric: +0.050" in text
        assert "Token savings (LLM tokens/query): 100.0x" in text
        assert "Cost savings ($/query): 10.0x" in text
        assert "Speedup (median latency): 10.0x" in text

    def test_missing_ball_knowledge_row_explains_why(self):
        text = render_headline_numbers({"bm25": {"ndcg10_mean": 0.3}})
        assert "ball_knowledge" in text

    def test_unpriced_jev_cost_reports_savings_as_unavailable(self):
        report = {
            "llm_only": {"ndcg10_mean": 0.4, "llm_tokens_per_query": 100_000, "cost_usd_per_query": 5.0, "median_latency_s": 200.0},
            "ball_knowledge": {"ndcg10_mean": 0.45, "llm_tokens_per_query": 1_000, "cost_usd_per_query": None, "median_latency_s": 20.0},
        }
        text = render_headline_numbers(report)
        assert "Cost savings ($/query): n/a" in text
        assert "Token savings (LLM tokens/query): 100.0x" in text
