#!/usr/bin/env python3
"""What changes when the corpus changes -- and nothing else does.

The engine, the gate/score/rank arithmetic, the receipt and the question-writing
rules are corpus-agnostic. Pointing the system at a different pile takes exactly
three things, and this file is where all three live:

  1. the schema description handed to the rubric compiler
  2. the item formatter -- how one row becomes the text a judge model reads
  3. the display columns the API returns

Two domains are defined below. `works` is MIT research papers. `constituents` is a
school's advancement database, for the GiveCampus challenge. They share every line of
pipeline code.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Domain:
    name: str
    db: str
    processed: str
    table: str
    id_col: str
    label_col: str                     # what to call a row in the UI
    schema_desc: str                   # given to the rubric compiler
    select_cols: list[str]             # fetched for candidates
    index_sql: str                     # text that gets embedded and BM25-indexed
    default_fields: list[str]          # fields a question reads when it names none
    format_item: Callable[[dict, list[str] | None], str]
    examples: list[str] = field(default_factory=list)
    # Optional: dollars (or any value) at stake for one row. When a domain supplies
    # this, ranking stops being "how well does this match" and becomes "how much is
    # it worth to act on this" -- which is the actual objective for a gift officer
    # with forty hours and thousands of names.
    value_of: Callable[[dict], float] | None = None
    value_label: str = ""
    # How many gate survivors get the expensive full-rubric pass. Lower it where the
    # gates are permissive: on the constituent file they passed more than the old cap
    # of 600, so the cap itself was doing the filtering rather than the rubric.
    full_rubric_max: int = 600


def _fmt(row: dict, fields: list[str] | None, order: list[str]) -> str:
    """Jev reads text, and only the fields a question names -- extra detail costs
    tokens and lowers accuracy, so the formatter is deliberately narrow."""
    keep = fields or order
    parts = []
    for f in keep:
        v = row.get(f)
        if v in (None, "", [], 0.0):
            continue
        label = f.replace("_", " ").capitalize()
        if isinstance(v, list):
            v = ", ".join(str(x) for x in v if x)
            if not v:
                continue
        parts.append(f"{label}: {v}")
    return "\n".join(parts)


WORKS_ORDER = ["title", "abstract", "venue", "publication_year", "field", "topic"]
CONSTITUENT_ORDER = [
    "full_name", "class_year", "school", "city", "state", "job_title", "employer",
    "industry", "seniority", "lifetime_giving", "gift_count", "last_gift_year",
    "years_since_last_gift", "largest_gift", "last_gift_amount", "is_recurring",
    "recurring_monthly", "events_attended", "volunteer_roles", "clubs", "athletics",
    "preferred_designation", "years_to_reunion", "years_since_contact",
    "assigned_officer", "notes",
]

WORKS = Domain(
    name="works",
    db="data/processed/ball.duckdb",
    processed="data/processed",
    table="works",
    id_col="work_id",
    label_col="title",
    schema_desc="""\
Table `works` (one row per MIT paper, 2015-2026):
  work_id TEXT, title TEXT, abstract TEXT, publication_year INT, type TEXT,
  cited_by_count INT, fwci DOUBLE, venue TEXT, topic TEXT, subfield TEXT,
  field TEXT, domain TEXT, keywords TEXT[], n_authors INT, is_oa BOOLEAN
""",
    select_cols=["work_id", "title", "abstract", "publication_year", "venue", "topic",
                 "field", "subfield", "cited_by_count", "n_authors", "is_oa", "doi",
                 "oa_url", "topic_names", "keywords"],
    index_sql="coalesce(title,'') || ' ' || coalesce(abstract,'')",
    default_fields=["title", "abstract"],
    format_item=lambda row, fields: _fmt(row, fields, WORKS_ORDER),
    examples=["protein structure prediction using deep learning",
              "superconducting qubit experiments, not theory",
              "soft robotics with compliant actuators"],
)


def _constituent_value(row: dict) -> float:
    """Dollars plausibly at stake if this person is contacted and says yes.

    Lifetime giving is the floor. A single large gift signals capacity beyond what
    the running total shows, so the largest gift is scaled up; a recurring donor's
    upgrade potential is a year of their current rate. Someone who has never given
    is not worth zero -- volunteers and reunion-year alumni do convert -- but they
    are worth far less than a proven donor, and the ordering has to say so.
    """
    lifetime = float(row.get("lifetime_giving") or 0)
    largest = float(row.get("largest_gift") or 0)
    recurring = float(row.get("recurring_monthly") or 0) * 12
    engaged = (len(row.get("volunteer_roles") or []) * 250
               + int(row.get("events_attended") or 0) * 60
               + (500 if (row.get("years_to_reunion") == 0) else 0))
    return max(lifetime, largest * 3.0, recurring * 2.0, engaged, 25.0)

CONSTITUENTS = Domain(
    name="constituents",
    db="data/givecampus/givecampus.duckdb",
    processed="data/givecampus",
    table="constituents",
    id_col="constituent_id",
    label_col="full_name",
    schema_desc="""\
Table `constituents` (one row per person in a school's advancement database):
  constituent_id TEXT, full_name TEXT, first_name TEXT, last_name TEXT,
  class_year INT, years_since_graduation INT, school TEXT, city TEXT, state TEXT,
  lifetime_giving DOUBLE, gift_count INT, first_gift_year INT, last_gift_year INT,
  years_since_last_gift INT, largest_gift DOUBLE, last_gift_amount DOUBLE,
  is_recurring BOOLEAN, recurring_monthly DOUBLE,
  events_attended INT, volunteer_roles TEXT[], clubs TEXT[], athletics TEXT,
  employer TEXT, job_title TEXT, industry TEXT, seniority TEXT,
  email_opens_12mo INT, email_clicks_12mo INT, years_since_contact INT,
  assigned_officer TEXT, preferred_designation TEXT, years_to_reunion INT,
  student_worker BOOLEAN, notes TEXT

`notes` is free text written by gift officers. It carries the things no structured
field records: why someone stopped giving, what they care about, how they want to be
contacted, what changed in their life. Questions that require judgement should read
`notes`; questions about amounts, dates or counts belong in `filters` as SQL.
Today is 2026. `years_to_reunion` of 0 means this is their reunion year.

WHAT THIS IS FOR. The reader is a gift officer with about forty hours a week and
thousands of people on their list. A result is only useful if contacting that person
is a good use of one of those hours. Giving is extremely concentrated -- in this file
the top tenth of donors hold about ninety per cent of the dollars -- so a list of
people who have never given is worse than no list at all, however engaged they look.

ALWAYS WRITE FILTERS. Unless the question explicitly asks about non-donors or
first-time prospects, put a floor on giving history in `filters` -- for example
`gift_count >= 1`, or `lifetime_giving >= 1000` when the question implies capacity.
Prior giving is the single strongest predictor of future giving, it is a structured
column, and SQL is free. Use `filters` for every amount, date and count: capacity
(`lifetime_giving`, `largest_gift`), recency (`years_since_last_gift`), timing
(`years_to_reunion = 0`), and neglect (`years_since_contact >= 3`,
`assigned_officer IS NULL`).

WHAT THE JUDGEMENT QUESTIONS ARE FOR. Reserve `gates` and `scores` for what only the
notes can answer: whether something changed in this person's life that raises their
capacity, whether there is an unresolved grievance, what they have said they care
about, whether they are warm to contact. Do not ask a judge model to infer amounts or
dates that are already columns.
""",
    select_cols=["constituent_id", "full_name", "class_year", "school", "city", "state",
                 "lifetime_giving", "gift_count", "last_gift_year",
                 "years_since_last_gift", "largest_gift", "last_gift_amount",
                 "is_recurring", "recurring_monthly", "events_attended",
                 "volunteer_roles", "clubs", "athletics", "employer", "job_title",
                 "industry", "seniority", "email_opens_12mo", "email_clicks_12mo",
                 "years_since_contact", "assigned_officer", "preferred_designation",
                 "years_to_reunion", "student_worker", "notes"],
    index_sql=("coalesce(full_name,'') || ' ' || coalesce(job_title,'') || ' ' || "
               "coalesce(employer,'') || ' ' || coalesce(industry,'') || ' ' || "
               "coalesce(city,'') || ' ' || coalesce(school,'') || ' ' || "
               "coalesce(array_to_string(volunteer_roles,' '),'') || ' ' || "
               "coalesce(array_to_string(clubs,' '),'') || ' ' || "
               "coalesce(athletics,'') || ' ' || coalesce(preferred_designation,'') "
               "|| ' ' || coalesce(notes,'')"),
    default_fields=["full_name", "class_year", "job_title", "employer", "notes"],
    format_item=lambda row, fields: _fmt(row, fields, CONSTITUENT_ORDER),
    examples=[
        "the 20 people I should reach before Giving Day, and why those 20",
        "loyal donors nobody has asked in five years",
        "alumni who were just promoted and are still being asked for an old gift amount",
        "recurring donors who have never been asked to increase their gift",
        "reunion-year alumni who volunteer but have never given",
    ],
    value_of=_constituent_value,
    value_label="dollars at stake",
    full_rubric_max=200,
)

DOMAINS = {d.name: d for d in (WORKS, CONSTITUENTS)}


def get(name: str) -> Domain:
    if name not in DOMAINS:
        raise KeyError(f"unknown domain {name!r}; have {sorted(DOMAINS)}")
    return DOMAINS[name]
