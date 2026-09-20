# GiveCampus — constituent intelligence

The same engine that searches 152,713 research papers, pointed at a school's
advancement database. Nothing in the pipeline changed: the rubric compiler, the
gate/score/rank arithmetic, the receipt and the question-writing rules are the same
code. Porting took the three things `src/ballknowledge/domain.py` defines — a schema
description, an item formatter, and the columns to display.

> **The dataset in this branch is synthetic.** 25,000 generated constituents with no
> connection to any real person. It exists so the adapter could be built and shown
> before the real file arrived. `scripts/make_constituents.py` produced it; pointing
> `CONSTITUENTS.db` at a real export is the only change needed.

## Running it

```bash
uv run python scripts/make_constituents.py -n 25000   # synthetic data
uv run python scripts/index_domain.py --domain constituents
PYTHONPATH=src uv run python -m uvicorn ballknowledge.api:app --port 8000
```

Indexing 25,000 constituents takes **42 seconds and $0.02**.

## What it answers

> *"who are the 20 people I need to reach before Giving Day, and why those 20?"*

That query compiles to SQL filters (`gift_count >= 1`, `years_since_contact >= 1`,
`assigned_officer IS NULL`), narrowing 25,000 rows to a few hundred, then a judge
model reads every survivor's officer notes and answers the questions only prose can
settle — has something changed in their life, is there an unresolved grievance, what
have they said they care about. Code ranks the result. About 15 seconds, roughly
three cents.

Measured on the synthetic file:

| query | dollars at stake, top 5 |
|---|---|
| loyal major donors nobody has asked in five years | **$7,921,985** |
| the 20 people I need to reach before Giving Day | $306,115 |

The first one surfaces a $1.04M lifetime donor with no assigned officer for three
cycles, and a $2.99M recurring donor who has never been asked to increase.

## The two decisions that made it useful

**Ranking is expected value, not relevance.** The first version returned people who
had never given a dollar — engaged, plausible, worthless to a gift officer with forty
hours a week. Giving is extremely concentrated (in this file the top tenth of donors
hold about 90% of the dollars), so the ranker now multiplies rubric fit by dollars at
stake, taken in log space so one enormous gift cannot outrank genuine fit:

```python
value = max(
    lifetime_giving,              # what they have actually given
    largest_gift * 3,             # one big gift signals capacity the total hides
    recurring_monthly * 12 * 2,   # two years at their current rate
    engagement_proxy,             # volunteer 250 + events*60 + reunion 500
    25.0,                         # floor: nobody is worth literally zero
)
norm  = (log(value) - log(min)) / (log(max) - log(min))   # across the survivors
score = fit * (0.35 + 0.65 * norm)
```

`max` rather than a sum, because these are alternative readings of the same capacity
and adding them would double-count a recurring donor's lifetime total. Log space so
one very large donor cannot outrank genuine fit. Normalised within the result set, so
it orders this query rather than scoring people absolutely. The 0.35 floor means a
perfect-fit small donor still beats a poor-fit large one: capacity tilts the ranking,
it does not replace it.

That single change moved the top-5 total from **$974 to $7.9M** on the same query.

**What this number is not.** It is a capacity proxy, not a forecast -- "a conversation
here is worth roughly this much", not "this person will give $142,807". The
multipliers are judgement rather than fitted values: no outcome data exists here to
fit them against, and they were tuned on a synthetic distribution. Given a real file
with contact and response history, they should be fitted, and the ranking would then
be an expected value in the proper sense rather than a well-reasoned heuristic.

**Amounts and dates are SQL; judgement is the judge model.** The schema description
tells the compiler to put every threshold in `filters` and reserve gates and scores
for what only the notes can answer. Prior giving is the strongest predictor of future
giving, it is a structured column, and SQL is free.

## What the free text is for

`notes` is the column that makes this a judgement problem rather than a query. Class
year and lifetime giving have always been filterable. What no query language reaches
is *"mentioned wanting to fund scholarships when her kids finish college"* or
*"frustrated about the stadium project and prefers their gift restricted to financial
aid"*. Those decide who to call on Tuesday, and they are what the judge model reads.

## One bug worth recording

Adding this domain silently broke filtering, and the failure hid itself. The SQL
allowlist added for injection defence was a hand-maintained list of the *research*
schema's columns, so every legitimate constituent filter — `gift_count >= 1`,
`years_since_last_gift <= 5` — was rejected. Queries still returned results, just
unfiltered ones, which is why it took inspecting the output rather than an error to
notice. The allowlist is now read from the live table schema, so it cannot drift from
the data again. Injection is still blocked; see `RESULTS.md` §9.
