from ball_knowledge.models import Criterion, CriterionKind, CriterionResult, CriterionVerdict, TrialLabel
from ball_knowledge.pipeline.patient_to_trials import _label_and_score


def crit(kind: CriterionKind, verdict: CriterionVerdict, probabilities=None) -> CriterionResult:
    criterion = Criterion(trial_id="NCT1", index=0, kind=kind, text="x")
    return CriterionResult(criterion, verdict, "code" if probabilities is None else "jev", probabilities=probabilities)


def test_all_inclusions_meet_no_exclusions_triggered_is_eligible():
    results = [
        crit(CriterionKind.INCLUSION, CriterionVerdict.MEETS),
        crit(CriterionKind.EXCLUSION, CriterionVerdict.DOES_NOT_MEET),
    ]
    label, score = _label_and_score(results)
    assert label is TrialLabel.ELIGIBLE
    assert score == 1.0


def test_failed_inclusion_is_excluded():
    results = [crit(CriterionKind.INCLUSION, CriterionVerdict.DOES_NOT_MEET)]
    label, _score = _label_and_score(results)
    assert label is TrialLabel.EXCLUDED


def test_triggered_exclusion_is_excluded():
    results = [crit(CriterionKind.EXCLUSION, CriterionVerdict.MEETS)]
    label, _score = _label_and_score(results)
    assert label is TrialLabel.EXCLUDED


def test_not_stated_does_not_disqualify():
    results = [
        crit(CriterionKind.INCLUSION, CriterionVerdict.NOT_STATED),
        crit(CriterionKind.EXCLUSION, CriterionVerdict.NOT_STATED),
    ]
    label, score = _label_and_score(results)
    assert label is TrialLabel.ELIGIBLE
    assert 0.0 < score < 1.0  # ranked below a fully-confirmed match, but not disqualified


def test_no_criteria_defaults_to_eligible_with_full_score():
    label, score = _label_and_score([])
    assert label is TrialLabel.ELIGIBLE
    assert score == 1.0


def test_jev_probabilities_drive_rank_score():
    results = [crit(CriterionKind.INCLUSION, CriterionVerdict.MEETS, probabilities={"meets": 0.7, "does_not_meet": 0.2, "not_stated": 0.1})]
    label, score = _label_and_score(results)
    assert label is TrialLabel.ELIGIBLE
    assert score == 0.7
