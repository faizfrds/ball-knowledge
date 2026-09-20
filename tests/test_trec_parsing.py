from pathlib import Path

from ball_knowledge.data.trec_ct import parse_age, parse_qrels, parse_topics, parse_trial_xml

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def test_parse_age():
    assert parse_age("18 Years") == 18.0
    assert parse_age("6 Months") == 0.5
    assert parse_age("N/A") is None
    assert parse_age(None) is None
    assert parse_age("") is None


def test_parse_trial_xml():
    xml_bytes = (FIXTURES / "sample_trial.xml").read_bytes()
    trial = parse_trial_xml(xml_bytes)

    assert trial.nct_id == "NCT99999999"
    assert "Investigational Drug X" in trial.brief_title
    assert "Rheumatoid Arthritis" in trial.conditions
    assert trial.gender == "All"
    assert trial.minimum_age_years == 18.0
    assert trial.maximum_age_years == 75.0
    assert trial.overall_status == "Recruiting"
    assert trial.phase == "Phase 3"
    assert trial.study_type == "Interventional"
    assert trial.enrollment == 450
    assert "Inclusion Criteria" in trial.eligibility_criteria_text
    assert "Exclusion Criteria" in trial.eligibility_criteria_text
    assert any("Placebo" in a for a in trial.arm_groups)
    assert "Drug X" in trial.interventions
    assert "ACR20 response at Week 24" in trial.outcomes
    assert "Change from baseline in DAS28-CRP" in trial.outcomes


def test_parse_topics_roundtrip(tmp_path):
    xml = """<topics task="test">
<topic number="1">First patient note.</topic>
<topic number="2">Second patient note.</topic>
</topics>"""
    path = tmp_path / "topics.xml"
    path.write_text(xml)
    topics = parse_topics(path)
    assert topics == [("1", "First patient note."), ("2", "Second patient note.")]


def test_parse_qrels(tmp_path):
    path = tmp_path / "qrels.txt"
    path.write_text("1 0 NCT00000001 2\n1 0 NCT00000002 1\n1 0 NCT00000003 0\n")
    qrels = parse_qrels(path)
    assert len(qrels) == 3
    assert qrels[0].topic_id == "1"
    assert qrels[0].nct_id == "NCT00000001"
    assert qrels[0].relevance == 2
