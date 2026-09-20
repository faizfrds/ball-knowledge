#!/usr/bin/env python3
"""Compile a plain-English question into a machine-runnable rubric.

The LLM appears exactly twice in the whole system: here, writing the rubric once per
query, and at the very end writing one-line explanations for the top results. Both
calls are small and neither grows with the size of the pile.

Rubric parts and where they run:
  filters    hard conditions on structured columns  -> SQL
  phrasings  2-5 search strings                     -> BM25 + embeddings
  gates      must-have yes/no questions             -> Jev Noul
  scores     graded preferences, 3-4 levels         -> Jev Score
  bonuses    nice-to-haves                          -> Jev Noul
  tags       categories for grouping                -> Jev Choice
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

MODEL = os.environ.get("BK_LLM_MODEL", "gpt-5.2")

SCHEMA_DESC = """\
Table `works` (one row per MIT paper, 2000-2026):
  work_id TEXT, title TEXT, abstract TEXT, publication_year INT, type TEXT,
  cited_by_count INT, fwci DOUBLE, venue TEXT, topic TEXT, subfield TEXT,
  field TEXT, domain TEXT, keywords TEXT[], n_authors INT, is_oa BOOLEAN
Table `groups` (research groups recovered from co-authorship):
  group_id TEXT, size INT, lead_author TEXT, member_names TEXT[], n_papers INT,
  total_citations INT, top_topics TEXT[], top_fields TEXT[], first_year INT, last_year INT
Table `authors`:
  author_id TEXT, author_name TEXT, group_id TEXT, n_papers INT,
  total_citations INT, top_topics TEXT[], recent_titles TEXT[], last_year INT
"""

RULES = """\
Rules for the yes/no and graded questions (these run on Jev, a small judge model):
- Literal and complete: Jev answers exactly what is written, so put boundary cases
  into the true/false criteria rather than leaving them implied.
- One judgment per question, unless both parts must hold of the same thing.
- No numbers, dates or counts in questions. Those belong in `filters`, which run as
  SQL. If a question needs a threshold, phrase it in words.
- Positive phrasing only. Ask "is this X?"; negate with 1-p in code afterwards.
- Name only the fields the question actually needs; extra text lowers accuracy.
"""

PROMPT = """You turn a research-search question into a rubric that a search engine runs.

{schema}
{rules}

Return ONLY a JSON object with these keys:
  "target": the table named in the schema above
  "filters": array of SQL boolean expressions over the target table (may be empty)
  "phrasings": 2-5 short search strings capturing different wordings of the need
  "gates": array of {{"id","q","true","false","fields"}} - must-have yes/no checks
  "scores": array of {{"id","q","levels":[lowest,...,highest],"weight","fields"}}
  "bonuses": array of {{"id","q","true","false","fields"}} - nice-to-haves
  "tags": array of {{"id","q","options":{{key:description}}}} - optional, for grouping

Keep it tight: at most 3 gates, 2 scores, 2 bonuses. Score weights sum to 1.0.

User question: {query}"""


@dataclass
class Rubric:
    target: str = "works"
    filters: list[str] = field(default_factory=list)
    phrasings: list[str] = field(default_factory=list)
    gates: list[dict] = field(default_factory=list)
    scores: list[dict] = field(default_factory=list)
    bonuses: list[dict] = field(default_factory=list)
    tags: list[dict] = field(default_factory=list)
    raw_query: str = ""

    @classmethod
    def from_dict(cls, d: dict, query: str = "") -> "Rubric":
        return cls(
            target=d.get("target", "works"),
            filters=list(d.get("filters") or []),
            phrasings=list(d.get("phrasings") or []) or ([query] if query else []),
            gates=list(d.get("gates") or []),
            scores=list(d.get("scores") or []),
            bonuses=list(d.get("bonuses") or []),
            tags=list(d.get("tags") or []),
            raw_query=query,
        )

    def as_dict(self) -> dict:
        return {"target": self.target, "filters": self.filters,
                "phrasings": self.phrasings, "gates": self.gates,
                "scores": self.scores, "bonuses": self.bonuses, "tags": self.tags}

    def jev_questions(self, include_scores: bool = True) -> dict[str, Any]:
        """The rubric as Jev question objects, keyed by rubric id."""
        from .jev import choice, noul, score as score_q
        qs: dict[str, Any] = {}
        for g in self.gates:
            qs[f"gate__{g['id']}"] = noul(g["q"], g.get("true", "yes"), g.get("false", "no"))
        if include_scores:
            for s in self.scores:
                qs[f"score__{s['id']}"] = score_q(s["q"], s["levels"])
            for b in self.bonuses:
                qs[f"bonus__{b['id']}"] = noul(b["q"], b.get("true", "yes"), b.get("false", "no"))
            for t in self.tags:
                qs[f"tag__{t['id']}"] = choice(t["q"], t["options"])
        return qs


@dataclass
class LLMUsage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def cost_usd(self) -> float:
        # Token counts are measured; dollars are not, because they depend on a rate
        # card that changes. Set BK_LLM_PRICE_IN / BK_LLM_PRICE_OUT (dollars per
        # million tokens) for the model in use. Unset, this reports 0 rather than a
        # number invented from an older model's pricing.
        pin = float(os.environ.get("BK_LLM_PRICE_IN", "0"))
        pout = float(os.environ.get("BK_LLM_PRICE_OUT", "0"))
        return self.input_tokens / 1e6 * pin + self.output_tokens / 1e6 * pout

    def add(self, resp) -> None:
        self.calls += 1
        u = getattr(resp, "usage", None)
        if u:
            self.input_tokens += u.prompt_tokens or 0
            self.output_tokens += u.completion_tokens or 0

    def as_dict(self) -> dict:
        priced = bool(os.environ.get("BK_LLM_PRICE_IN") or os.environ.get("BK_LLM_PRICE_OUT"))
        return {"calls": self.calls, "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens,
                "cost_usd": round(self.cost_usd, 6), "priced": priced,
                "model": MODEL}


def compile_rubric(query: str, usage: LLMUsage | None = None,
                   model: str = MODEL, schema: str | None = None) -> Rubric:
    from openai import OpenAI
    client = OpenAI()
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user",
                   "content": PROMPT.format(schema=schema or SCHEMA_DESC,
                                            rules=RULES, query=query)}],
        response_format={"type": "json_object"},
        temperature=0,
    )
    if usage:
        usage.add(resp)
    return Rubric.from_dict(json.loads(resp.choices[0].message.content), query)


EXPLAIN_MODEL = os.environ.get("BK_EXPLAIN_MODEL", "gpt-5.4-mini")


def explain(query: str, items: list[dict], usage: LLMUsage | None = None,
            model: str = EXPLAIN_MODEL) -> list[str]:
    """One line per top result saying why it is there. Jev returns no text, so this
    is the only place explanations can come from."""
    from openai import OpenAI
    client = OpenAI()
    listing = "\n".join(
        f"{i+1}. {it.get('title') or it.get('full_name') or it.get('name')} "
        f"— {(it.get('why_context') or '')[:300]}"
        for i, it in enumerate(items))
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content":
                   f'Question: "{query}"\n\nResults:\n{listing}\n\n'
                   f"For each numbered result write ONE short sentence giving the "
                   f"SPECIFIC reason it belongs in this answer -- name the fact that "
                   f"makes it qualify. Never restate the question, never say the item "
                   f"'matches' or 'was chosen'; if the only thing you can say is that "
                   f"it appeared in the results, say what is actually known about it "
                   f"instead. Return JSON: "
                   f'{{"reasons": ["...", "..."]}} in the same order.'}],
        response_format={"type": "json_object"},
        temperature=0,
    )
    if usage:
        usage.add(resp)
    return json.loads(resp.choices[0].message.content).get("reasons", [])
