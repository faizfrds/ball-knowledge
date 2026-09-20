# Data dictionary

## Conventions

- Integer primary keys are named `id`.
- Foreign keys use `<table singular>_id` and are integers.
- An empty CSV field means null. Empty strings are not a separate value.
- Dates use `YYYY-MM-DD`. Timestamps use ISO 8601 UTC.
- Money fields are decimal USD values with two digits after the decimal point.
- Booleans use `true` and `false`.
- Every table is scoped to `schools.id` through `school_id`, except `schools.csv` itself.

## Relationships

```text
schools
├── staff
├── constituents ── assigned_staff_id ──> staff
│   ├── affiliations
│   ├── degrees
│   ├── activities
│   ├── career_history
│   ├── event_attendance ──> events
│   ├── gifts ──> gift_allocations ──> funds
│   ├── interactions
│   └── opportunities
├── campaigns ── default_fund_id ──> funds
├── events ── related_campaign_id ──> campaigns
└── funds

opportunities ──> constituents, staff, campaigns, funds
gifts ──> constituents, campaigns, opportunities, gifts (parent)
interactions ──> constituents, staff, opportunities, campaigns, gifts
```

## `schools.csv`

One row per institution.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | School primary key |
| `name` | string | No | Fictional institution name |
| `school_type` | enum | No | `university`, `college`, or `independent_school` |
| `fiscal_year_start_month` | integer | No | Month number from 1 to 12 |
| `timezone` | string | No | IANA time-zone name |
| `currency` | string | No | ISO 4217 currency code |

## `staff.csv`

One row per advancement staff member.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Staff primary key |
| `school_id` | integer | No | School foreign key |
| `display_name` | string | No | Synthetic staff display name |
| `role` | enum | No | `Major Gift Officer`, `Annual Giving`, `Advancement Services`, `Events`, or `Leadership` |
| `region` | string | No | Geographic or national coverage area |
| `portfolio_capacity` | integer | Yes | Approximate constituent capacity; null for non-portfolio roles |
| `active` | boolean | No | Whether the staff record is active |

Only active `Major Gift Officer` rows may be referenced by `constituents.assigned_staff_id` or `opportunities.staff_id`.

## `constituents.csv`

One current identity and contactability record per constituent.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Constituent primary key |
| `school_id` | integer | No | School foreign key |
| `entity_type` | enum | No | `individual` or `organization` |
| `preferred_name` | string | No | Synthetic display name for an individual or organization |
| `first_name` | string | Yes | Synthetic given name; null for organizations |
| `last_name` | string | Yes | Synthetic family name; null for organizations |
| `primary_email` | string | Yes | Synthetic email under a reserved `.example` domain |
| `email_status` | enum | No | `deliverable`, `do_not_email`, `inactive`, or `missing` |
| `phone_status` | enum | No | `available`, `do_not_call`, `inactive`, or `missing`; no phone number is supplied |
| `city` | string | Yes | Current city |
| `state` | string | Yes | State or province; US values use abbreviations in this school |
| `country` | string | Yes | Country name |
| `latitude` | decimal | Yes | Synthetic four-decimal latitude spread across a metro area |
| `longitude` | decimal | Yes | Synthetic four-decimal longitude spread across a metro area |
| `assigned_staff_id` | integer | Yes | Active Major Gift Officer responsible for the constituent |
| `do_not_solicit` | boolean | No | Prohibits gift solicitation |
| `deceased` | boolean | No | Whether the individual is recorded as deceased |
| `deceased_date` | date | Yes | Recorded date of death; populated when `deceased = true` |
| `record_source` | enum | No | `crm_import`, `online`, or `advancement_entry` |
| `record_created_at` | timestamp | No | When the constituent record was created |
| `record_updated_at` | timestamp | No | Most recent record update as of the cutoff |

## `affiliations.csv`

One institutional relationship per constituent. Affiliation types are not mutually exclusive: the same constituent can be an alumnus, parent, employee, trustee, or friend in different rows. At most one row is primary.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Affiliation primary key |
| `school_id` | integer | No | School foreign key |
| `constituent_id` | integer | No | Constituent foreign key |
| `affiliation_type` | enum | No | `alumni`, `parent`, `student`, `employee`, `trustee`, or `friend` |
| `raw_affiliation_value` | string | No | Source-system label before normalization |
| `start_year` | integer | Yes | First known year of the relationship |
| `end_year` | integer | Yes | Final known year; null can mean current or unknown |
| `is_primary` | boolean | No | Whether this is the constituent's primary relationship |
| `record_source` | enum | No | Source of the relationship record |

## `degrees.csv`

One degree or program record linked directly to a constituent who has an `alumni` or `student` affiliation.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Degree primary key |
| `school_id` | integer | No | School foreign key |
| `constituent_id` | integer | No | Constituent foreign key |
| `degree_type` | string | Yes | School-specific degree label |
| `school_or_unit` | string | No | Academic school or college |
| `major` | string | Yes | Major or program |
| `class_year` | integer | Yes | Graduation or expected graduation year |
| `start_year` | integer | Yes | Program start year |
| `record_source` | enum | No | Source of the degree record |

Future class years are valid for current students. Missing fields reflect incomplete imported history. For reunion analysis, use the earliest undergraduate degree (`B.A.`, `A.B.`, `B.S.`, or `B.B.A.` in this school) with a non-null `class_year`.

## `activities.csv`

One named school activity membership per constituent.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Activity membership primary key |
| `school_id` | integer | No | School foreign key |
| `constituent_id` | integer | No | Constituent foreign key |
| `activity_type` | enum | No | `Club`, `Athletics`, `Greek Life`, `Committee`, or `Volunteer` |
| `activity_name` | string | No | Shared activity name used for segmentation |
| `role` | string | Yes | Leadership or participation role |
| `start_year` | integer | Yes | Membership start year |
| `end_year` | integer | Yes | Membership end year; null can mean current or unknown |
| `record_source` | enum | No | Source of the activity record |

## `campaigns.csv`

One fundraising campaign, appeal, crowdfunding project, or giving form.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Campaign primary key |
| `school_id` | integer | No | School foreign key |
| `name` | string | No | Campaign name |
| `campaign_type` | enum | No | `giving_day`, `annual_fund`, `crowdfunding`, `reunion`, `athletics`, `emergency`, `capital`, or `general_form` |
| `audience_description` | string | No | Intended audience |
| `goal_type` | enum | No | `dollar` or `donor` |
| `goal_amount` | money | Conditional | Populated only for a `dollar` goal |
| `goal_donor_count` | integer | Conditional | Populated only for a `donor` goal |
| `starts_at` | timestamp | No | Campaign start |
| `ends_at` | timestamp | No | Campaign end |
| `status` | enum | No | `active`, `upcoming`, `completed`, or `archived` |
| `default_fund_id` | integer | No | Default fund foreign key |
| `is_recurring_enabled` | boolean | No | Whether the campaign accepts recurring commitments |
| `is_match_or_challenge_active` | boolean | No | Whether a match or challenge is active for the campaign |

Exactly one goal value is populated according to `goal_type`.

## `funds.csv`

One fund or designation.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Fund primary key |
| `school_id` | integer | No | School foreign key |
| `name` | string | No | Current public fund name |
| `fund_code` | string | No | School-specific code |
| `category` | string | No | Broad purpose category |
| `active` | boolean | No | Whether new gifts should use the fund |

## `gifts.csv`

One gift transaction, pledge, recurring commitment, or installment.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Gift primary key |
| `school_id` | integer | No | School foreign key |
| `constituent_id` | integer | No | Constituent foreign key |
| `campaign_id` | integer | Yes | Campaign foreign key; often missing for imported history |
| `opportunity_id` | integer | Yes | Managed opportunity fulfilled or supported by this gift |
| `gift_date` | date | No | Transaction, pledge, or commitment date |
| `amount` | money | No | Recorded amount in `currency` |
| `currency` | string | No | ISO 4217 currency code |
| `status` | enum | No | `paid`, `pledged`, `pending`, `failed`, or `refunded` |
| `gift_type` | enum | No | `one_time`, `recurring_parent`, `installment`, `pledge`, or `matching_gift` |
| `gift_channel` | enum | Yes | Known acquisition channel: `online`, `event`, `mail`, or `phone`; null when unknown |
| `record_source` | enum | No | Row provenance: `givecampus`, `crm_import`, or `advancement_entry` |
| `payment_method` | enum | No | `credit_card`, `check`, `bank_transfer`, `stock`, `other`, or a similar coarse method |
| `anonymous` | boolean | No | Exclude from public recognition, not internal fundraising analysis |
| `fiscal_year` | integer | No | Fiscal year ending year; the school starts its fiscal year in July |
| `external_id` | string | Yes | Opaque synthetic source identifier; not guaranteed to be populated or consistently formatted |
| `linked_parent_gift_id` | integer | Yes | Parent gift for an installment or matching gift |

For received-cash analysis, filter to `status = 'paid'`. A `recurring_parent.amount` is the total planned commitment, and its `installment` children are transactions. Do not add both when measuring received cash.

## `gift_allocations.csv`

One gift-to-fund allocation.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Allocation primary key |
| `school_id` | integer | No | School foreign key |
| `gift_id` | integer | No | Gift foreign key |
| `fund_id` | integer | Yes | Normalized fund foreign key; null only for an explicit legacy mapping gap |
| `amount` | money | No | Amount allocated to the fund |
| `raw_fund_name` | string | No | Fund label supplied by the source system |

Allocation amounts sum to the gift amount for every allocated gift, including the legacy mapping gap.

## `interactions.csv`

One constituent interaction authored or recorded by advancement staff.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Interaction primary key |
| `school_id` | integer | No | School foreign key |
| `constituent_id` | integer | No | Constituent foreign key |
| `staff_id` | integer | No | Staff author or solicitor foreign key |
| `occurred_at` | timestamp | No | Interaction time |
| `interaction_type` | enum | No | `email`, `call`, `text`, `meeting`, `event_follow_up`, or `note` |
| `direction` | enum | No | `outbound`, `inbound`, or `internal` |
| `purpose` | enum | No | `qualification`, `cultivation`, `solicitation`, `acknowledgement`, `stewardship`, or `data_update` |
| `outcome` | enum | No | `no_response`, `connected`, `replied`, `meeting_booked`, `declined`, `pledged`, `gift_received`, or `information_updated` |
| `ask_amount` | money | Yes | Populated for a solicitation interaction |
| `significant` | boolean | No | School-entered significance flag |
| `subject` | string | No | Synthetic interaction title |
| `notes` | string | No | Fully synthetic note text; repeated boilerplate and terse legacy-style entries are intentional |
| `follow_up_date` | date | Yes | Planned next follow-up, including intentionally overdue dates |
| `related_opportunity_id` | integer | Yes | Related opportunity foreign key |
| `related_campaign_id` | integer | Yes | Related campaign foreign key |
| `related_gift_id` | integer | Yes | Related gift foreign key |
| `record_source` | enum | No | `advancement_entry`, `crm_import`, or `profile_enrichment` |

## `events.csv`

One historical or upcoming school event.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Event primary key |
| `school_id` | integer | No | School foreign key |
| `name` | string | No | Event name |
| `event_type` | string | No | Event category such as `regional`, `reunion`, or `athletics` |
| `starts_at` | timestamp | No | Event start |
| `ends_at` | timestamp | No | Event end |
| `city` | string | No | Event city |
| `state` | string | No | State abbreviation |
| `latitude` | decimal | No | Coarse event latitude |
| `longitude` | decimal | No | Coarse event longitude |
| `audience_description` | string | No | Intended event audience |
| `capacity` | integer | No | Approximate attendance capacity |
| `related_campaign_id` | integer | Yes | Related fundraising campaign foreign key |

## `event_attendance.csv`

One actual historical event attendance record.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Attendance primary key |
| `school_id` | integer | No | School foreign key |
| `event_id` | integer | No | Historical event foreign key |
| `constituent_id` | integer | No | Constituent foreign key |
| `attended_at` | timestamp | No | Event occurrence time |
| `record_source` | enum | No | `event_import` or `advancement_entry` |

The file contains no registrations, invitations, guests, or email engagement.

## `career_history.csv`

One current or prior employment position. This table is fully synthetic and intentionally extends the current-field shape available in production.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Career row primary key |
| `school_id` | integer | No | School foreign key |
| `constituent_id` | integer | No | Constituent foreign key |
| `employer` | string | No | Synthetic employer name |
| `job_title` | string | Yes | Synthetic job title |
| `industry` | string | No | Broad industry |
| `started_at` | date | No | Position start date |
| `ended_at` | date | Yes | Position end date; null for current positions |
| `is_current` | boolean | No | Whether this is the constituent's current position |
| `recorded_at` | date | No | When advancement learned or recorded the position |
| `record_source` | enum | No | `profile_enrichment` or `crm_import` |

Every constituent represented in this file has exactly one row with `is_current = true`. Career ladders usually move upward in seniority and include starts through August 2026. Prior positions can end the day before a new role, leave an employment gap, or overlap a new role. Overlapping histories use recognizable board, advisory, volunteer, or part-time titles so they are distinguishable from impossible date ranges. Every non-current row has `started_at <= ended_at`.

## `opportunities.csv`

One managed fundraising ask or prospect opportunity.

| Column | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `id` | integer | No | Opportunity primary key |
| `school_id` | integer | No | School foreign key |
| `constituent_id` | integer | No | Primary constituent foreign key |
| `staff_id` | integer | No | Active Major Gift Officer owner |
| `campaign_id` | integer | Yes | Related campaign foreign key |
| `fund_id` | integer | Yes | Intended fund foreign key |
| `status` | enum | No | `identified`, `qualifying`, `cultivating`, `soliciting`, `committed`, `closed_won`, or `closed_lost` |
| `expected_ask_amount` | money | No | Current expected ask amount, generally based on prior giving and career or affiliation evidence |
| `ask_amount` | money | Yes | Actual ask amount once solicited |
| `accepted_amount` | money | Yes | Amount accepted or committed |
| `expected_ask_date` | date | No | Expected solicitation date |
| `ask_date` | date | Yes | Actual solicitation date |
| `response_date` | date | Yes | Date of a commitment or decline |
| `closed_at` | date | Yes | Date a won or lost opportunity closed |
| `close_reason` | string | Yes | Won/lost reason when applicable |
| `likelihood_band` | enum | No | `low`, `medium`, `high`, or `committed` |
| `notes` | string | Yes | Short synthetic opportunity context |

Open stages use future expected ask dates where appropriate. Won opportunities have related paid gifts; lost opportunities do not. Three intentional stretch asks exceed what gift history alone suggests and state the supporting evidence in `notes`.
