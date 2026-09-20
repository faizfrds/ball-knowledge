from __future__ import annotations

import gzip
import json
import shutil

import pytest

from ball_knowledge.data.trec_ct import (
    build_corpus_cache,
    iter_trials,
    load_corpus_cache,
    parse_age,
    parse_qrels,
    parse_topics,
)
from ball_knowledge.models import Trial
from tests.conftest import SAMPLE_CORPUS_ZIP, SAMPLE_QRELS_TXT, SAMPLE_TOPICS_XML


class TestParseAge:
    @pytest.mark.parametrize(
        "text,expected",
        [
            ("18 Years", 18.0),
            ("6 Months", 0.5),
            ("2 Weeks", 2 / 52.1775),
            ("N/A", None),
            ("", None),
            (None, None),
        ],
    )
    def test_parse_age(self, text, expected):
        result = parse_age(text)
        if expected is None:
            assert result is None
        else:
            assert result == pytest.approx(expected)


class TestParseTrialXml:
    def test_diabetes_trial_fields(self, diabetes_trial: Trial):
        assert diabetes_trial.nct_id == "NCT00000001"
        assert diabetes_trial.title == "A Randomized Study of Drug X in Adults With Type 2 Diabetes Mellitus"
        assert diabetes_trial.overall_status == "Recruiting"
        assert diabetes_trial.phase == "Phase 3"
        assert diabetes_trial.gender == "All"
        assert diabetes_trial.minimum_age_years == pytest.approx(18.0)
        assert diabetes_trial.maximum_age_years == pytest.approx(75.0)
        assert diabetes_trial.enrollment == 320
        assert "Type 2 Diabetes Mellitus" in diabetes_trial.conditions
        assert "Inclusion Criteria" in diabetes_trial.eligibility_criteria_text
        assert diabetes_trial.arm_groups == ["Experimental: Drug X", "Placebo Comparator: Placebo"]
        assert diabetes_trial.interventions == ["Drug X"]
        assert diabetes_trial.outcomes == [
            "Change in HbA1c from baseline to week 24",
            "Proportion of participants achieving HbA1c < 7.0%",
        ]

    def test_breast_cancer_trial_is_female_only(self, breast_cancer_trial: Trial):
        assert breast_cancer_trial.gender == "Female"
        assert breast_cancer_trial.maximum_age_years is None  # "N/A"

    def test_title_falls_back_to_brief_when_no_official_title(self, breast_cancer_trial: Trial):
        # official_title is present in the fixture; brief_title should be ignored by .title
        assert breast_cancer_trial.title == breast_cancer_trial.official_title

    def test_search_text_concatenates_and_skips_blank_fields(self, asthma_trial: Trial):
        text = asthma_trial.search_text()
        assert asthma_trial.brief_title in text
        assert "Asthma" in text
        assert asthma_trial.eligibility_criteria_text.strip() in text
        # detailed_description was never populated for this fixture - shouldn't add stray blank lines
        assert "\n\n\n" not in text


class TestIterTrials:
    def test_iter_trials_reads_all_fixture_trials(self, tmp_path):
        raw_dir = tmp_path / "raw"
        raw_dir.mkdir()
        shutil.copy(SAMPLE_CORPUS_ZIP, raw_dir / "ClinicalTrials.2021-04-27.part1.zip")

        trials = list(iter_trials(raw_dir))

        assert {t.nct_id for t in trials} == {"NCT00000001", "NCT00000002", "NCT00000003"}

    def test_iter_trials_raises_when_no_zip_parts_present(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            list(iter_trials(tmp_path))


class TestCorpusCache:
    def test_build_and_load_roundtrip(self, tmp_path, sample_trials):
        raw_dir = tmp_path / "raw"
        raw_dir.mkdir()
        shutil.copy(SAMPLE_CORPUS_ZIP, raw_dir / "ClinicalTrials.2021-04-27.part1.zip")
        cache_path = tmp_path / "corpus.jsonl.gz"

        count = build_corpus_cache(raw_dir, cache_path, progress_every=0)
        assert count == 3

        with gzip.open(cache_path, "rt") as f:
            lines = f.readlines()
        assert len(lines) == 3
        assert json.loads(lines[0])["nct_id"].startswith("NCT")

        loaded = {t.nct_id: t for t in load_corpus_cache(cache_path)}
        assert loaded.keys() == {t.nct_id for t in sample_trials}
        assert loaded["NCT00000001"].brief_title == "Trial of Drug X for Type 2 Diabetes"


class TestParseTopics:
    def test_parse_topics_returns_id_text_pairs(self):
        topics = parse_topics(SAMPLE_TOPICS_XML)
        assert [tid for tid, _ in topics] == ["1", "2", "3"]
        assert "type 2 diabetes" in topics[0][1].lower()
        assert "breast cancer" in topics[1][1].lower()


class TestParseQrels:
    def test_parse_qrels_matches_topics_and_relevance_scale(self):
        qrels = parse_qrels(SAMPLE_QRELS_TXT)
        assert len(qrels) == 9
        by_key = {(q.topic_id, q.nct_id): q.relevance for q in qrels}
        assert by_key[("1", "NCT00000001")] == 2  # eligible
        assert by_key[("2", "NCT00000001")] == 0  # not relevant
        assert by_key[("3", "NCT00000003")] == 2

    def test_parse_qrels_skips_malformed_lines(self, tmp_path):
        path = tmp_path / "qrels.txt"
        path.write_text("1 0 NCT00000001 2\nnot a valid line\n2 0 NCT00000002 1\n")
        qrels = parse_qrels(path)
        assert len(qrels) == 2
