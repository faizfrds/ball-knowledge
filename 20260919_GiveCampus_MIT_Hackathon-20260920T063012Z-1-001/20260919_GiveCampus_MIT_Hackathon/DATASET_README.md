# GiveCampus University synthetic dataset

This is version 1.2 of the 20,000-constituent release candidate for the HackMIT fundraising challenge. It contains 19,500 synthetic individuals, 500 synthetic organizations, and 14 related tables. No production row, identity, note, address, employer, or gift was copied or perturbed to create it.

The data is shaped by aggregate measurements from two GiveCampus schools. Its distributions and missingness are production-like at a smaller scale, while gifts, interactions, opportunities, career changes, events, and assignments remain coherent when joined.

## Start here

You can work with the CSV files directly, or load all 15 tables into SQLite with Python’s standard library:

```bash
python3 load_sqlite.py --output givecampus_hackmit.sqlite
sqlite3 givecampus_hackmit.sqlite < example_queries.sql
```

Use `schema.sql` for the executable schema, `ERD.md` for the relationship diagram, `example_queries.sql` for five join examples, and `DATA_DICTIONARY.md` for field meanings.

## Dataset contract

- Institution: **GiveCampus University**
- Dataset version: **1.2**
- As-of date: **2026-08-31**
- Generator seed: **260904**
- Format: 15 relational CSV files in `data/`
- Null representation: an empty CSV field
- Dates: ISO 8601 `YYYY-MM-DD`
- Timestamps: ISO 8601 UTC timestamps
- Currency: USD
- Primary keys: `id`
- No denormalized constituent CSV is included
- No constituent-to-constituent relationship or household file is included

Every school-scoped table includes `school_id`. Categorical values such as `alumni`, `parent`, and `dollar` appear directly in the CSVs instead of requiring lookup files. Constituent IDs are randomly permuted after cohort generation; the numeric ID has no intended demographic or giving meaning.

## Files

| File | Grain |
| --- | --- |
| `schools.csv` | One row per institution |
| `staff.csv` | One row per advancement staff member |
| `constituents.csv` | One current record per person or organization |
| `affiliations.csv` | One institutional relationship per constituent |
| `degrees.csv` | One degree or program record per constituent |
| `activities.csv` | One named activity membership per individual |
| `campaigns.csv` | One fundraising campaign or giving form |
| `funds.csv` | One designation or fund |
| `gifts.csv` | One gift, pledge, recurring commitment, or installment |
| `gift_allocations.csv` | One fund allocation per gift and fund |
| `interactions.csv` | One staff interaction with a constituent |
| `events.csv` | One historical or upcoming event |
| `event_attendance.csv` | One actual historical attendance record |
| `career_history.csv` | One current or prior employment position |
| `opportunities.csv` | One managed fundraising ask |

## What the data supports

The dataset supports the four suggested challenge directions and application-oriented projects such as dashboards, maps, natural-language search, recommendation tools, and web apps.

- Segmentation: 79 activities span clubs, athletics, Greek Life, service, and committees; event history includes repeat attendees; coordinates use continuous four-decimal metro-area variation.
- Next action: gifts, contactability, restrictions, future events, and interactions provide competing actions such as thank, invite, research, cultivate, or exclude.
- Hidden dollars: historical giving reaches back to 1990, while career histories include ordered promotion paths and recent changes through August 2026.
- Copilot and retrieval: names are highly varied, interaction notes mix narratives, repeated operational templates, and terse imported entries, and all major relationships can be joined through documented keys.

This is synthetic institutional data, so useful signals and imperfect records coexist. Missing values, repeated text, inactive records, late campaign attribution, legacy fund labels, stale asks, and sparse notes are intentional. File parsing and foreign-key repair are not part of the challenge.

## Important interpretation rules

### Constituents, affiliations, and degrees

Affiliation types are not mutually exclusive. A constituent can be an alumnus and a parent, employee, trustee, or another combination. Five hundred individuals intentionally have no affiliation row; use a left join when you need to retain the full constituent population.

Degrees link directly to constituents. For reunion analysis, use the earliest undergraduate degree (`B.A.`, `A.B.`, `B.S.`, or `B.B.A.` in this school) with a non-null `class_year`. Future class years belong to current students.

`deceased = true` and `deceased_date` are exclusion signals. A constituent may still have important historical giving, but no gift or interaction occurs after their recorded death date.

### Gifts and funds

Treat `status = 'paid'` as received cash. A `recurring_parent` row stores the total planned commitment, while linked `installment` rows store the transactions. Do not add both the parent and its installments as received cash.

`gift_channel` describes how a gift arrived when known. `record_source` describes where the row came from. Imported history may have no known channel. Failed, refunded, pending, and pledged rows are intentional. Most gifts have one fund allocation, some are split, and one legacy allocation has no normalized `fund_id` but keeps `raw_fund_name`.

The first campaign begins on `2019-07-01`, representing platform adoption. Earlier gift rows are imported institutional history with a null `campaign_id`. A small number of gifts are attributed after a campaign ended; late attribution is intentional. No gift precedes the start of its referenced campaign. Funds 23 and 24 are inactive today but retain historical allocations.

### Interactions and opportunities

Only active staff with the `Major Gift Officer` role own constituents or opportunities. Other staff can author interactions. An inactive officer has historical imported interactions but owns no current constituent or opportunity.

The 160 managed opportunities have stage-dependent histories: early prospects have several research and qualification touches, while mature opportunities have 12–24 interactions across calls, email, meetings, inbound replies, asks, acknowledgements, and stewardship. Ask amounts generally reflect prior paid giving plus career or affiliation evidence. Three deliberate stretch asks have explicit supporting evidence in their opportunity notes.

Interactions are not limited to opportunity constituents. Routine records mix reusable templates with constituent-specific variation. Another 1,200 imported legacy-style records contain short notes such as `made call`, `sent email`, or `left message`. Repeated text is realistic, but no exact note dominates the file. Regeneration requires no LLM or external API; selected high-touch narratives were authored and reviewed before being frozen into the generator.

### Events and locations

Each `event_attendance.csv` row means the constituent attended. It is not a registration, invitation, or email event. Future events have no attendance rows and provide options for invitation recommendations. Some constituents attend multiple events.

Coordinates are synthetic, four-decimal points spread across metro areas. Missing coordinates remain intentional. City labels include several suburbs around the dataset’s largest metros, so mapping and distance calculations add information beyond `GROUP BY city`.

### Career history

Career history is a synthetic extension. Production data largely supplies current employer and title fields, not a universal promotion timeline. The fixture therefore includes coherent two- to four-role ladders, recent starts through August 2026, and a small set of recognizable overlapping board, advisory, volunteer, or part-time roles. Most transitions move upward in seniority; some gaps, overlaps, and downward moves remain as realistic data-quality cases.

## Regeneration and internal review

The generator uses only built-in Node.js modules:

```bash
node generator.mjs ./data . 20000
node validate_csv_parse.mjs ./data
```

It recreates all 15 CSVs, runs relational, financial, temporal, ownership, lifecycle, distribution, and leakage assertions, and writes `validation-summary.json`.

`constituent-review.xlsx`, `REVIEW_GUIDE.md`, and `VALIDATION.md` are internal engineering-review artifacts. The workbook provides a joined constituent surface, a chronological review cohort, and an interaction-note review sheet. The relational CSVs remain the source of truth and the proposed student-facing format.
