from ball_knowledge.criteria.split import build_criteria, split_eligibility_text
from ball_knowledge.models import CriterionKind, Trial

ELIGIBILITY_TEXT = """
Inclusion Criteria:

  -  Age 18 to 75 years

  -  Diagnosis of rheumatoid arthritis for at least 6 months

  -  ALT and AST less than 2.5 x ULN

Exclusion Criteria:

  -  Active or latent tuberculosis

  -  Pregnant or nursing women
"""


def test_split_eligibility_text():
    inclusion, exclusion = split_eligibility_text(ELIGIBILITY_TEXT)
    assert len(inclusion) == 3
    assert len(exclusion) == 2
    assert "Age 18 to 75 years" in inclusion[0]
    assert "tuberculosis" in exclusion[0]


def test_split_eligibility_text_empty():
    assert split_eligibility_text("") == ([], [])
    assert split_eligibility_text(None) == ([], [])


def test_split_eligibility_text_no_headers_treated_as_inclusion():
    inclusion, exclusion = split_eligibility_text("Just one plain sentence with no headers.")
    assert exclusion == []
    assert len(inclusion) == 1


def test_build_criteria_indices_and_kinds():
    trial = Trial(nct_id="NCT00000001", eligibility_criteria_text=ELIGIBILITY_TEXT)
    criteria = build_criteria(trial)
    assert len(criteria) == 5
    assert [c.index for c in criteria] == [0, 1, 2, 3, 4]
    assert [c.kind for c in criteria[:3]] == [CriterionKind.INCLUSION] * 3
    assert [c.kind for c in criteria[3:]] == [CriterionKind.EXCLUSION] * 2
    assert all(c.trial_id == "NCT00000001" for c in criteria)
