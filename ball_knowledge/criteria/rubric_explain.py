"""Deterministic rubric-based explanations synthesized directly from Jev verdicts
and code evaluations, completely bypassing the secondary LLM call (`explain_top_trials`).
"""

from __future__ import annotations

from ball_knowledge.models import CriterionKind, CriterionVerdict, TrialLabel, TrialMatch


def format_deterministic_explanation(match: TrialMatch) -> str:
    """Produces a structured, audit-ready explanation paragraph and rubric breakdown
    from the trial's gate probability and criterion results without calling an LLM."""
    if match.label is TrialLabel.NOT_RELEVANT:
        gate_str = f"{match.gate_probability:.0%}" if match.gate_probability is not None else "low"
        return f"Not relevant to patient's primary condition (condition-gate match: {gate_str})."

    gate_desc = f"Passed condition gate ({match.gate_probability:.0%} match)" if match.gate_probability is not None else "Evaluated for condition match"

    # Identify primary disqualifiers if excluded
    failed_inclusions = [
        r for r in match.criterion_results
        if r.criterion.kind is CriterionKind.INCLUSION and r.verdict is CriterionVerdict.DOES_NOT_MEET
    ]
    triggered_exclusions = [
        r for r in match.criterion_results
        if r.criterion.kind is CriterionKind.EXCLUSION and r.verdict is CriterionVerdict.MEETS
    ]

    lines: list[str] = []

    if match.label is TrialLabel.ELIGIBLE:
        met_inclusions = [
            r for r in match.criterion_results
            if r.criterion.kind is CriterionKind.INCLUSION and r.verdict is CriterionVerdict.MEETS
        ]
        lines.append(
            f"Eligible. {gate_desc}; patient satisfies all evaluated criteria (score: {match.rank_score:.3f})."
        )
        if met_inclusions:
            key_inclusions = met_inclusions[:3]
            for r in key_inclusions:
                eval_tag = f"code: {r.detail}" if r.evaluated_by == "code" else "Jev verified"
                lines.append(f"  • Met inclusion: {r.criterion.text[:100]}... [{eval_tag}]")
        lines.append("  • No disqualifying exclusion criteria were triggered.")

    elif match.label is TrialLabel.EXCLUDED:
        lines.append(f"Excluded. {gate_desc}, but disqualified by eligibility criteria.")
        for r in triggered_exclusions[:3]:
            detail_tag = f" ({r.detail})" if r.detail else ""
            lines.append(f"  • Triggered exclusion: {r.criterion.text[:100]}...{detail_tag}")
        for r in failed_inclusions[:3]:
            detail_tag = f" ({r.detail})" if r.detail else ""
            lines.append(f"  • Failed inclusion: {r.criterion.text[:100]}...{detail_tag}")

    return "\n".join(lines)

