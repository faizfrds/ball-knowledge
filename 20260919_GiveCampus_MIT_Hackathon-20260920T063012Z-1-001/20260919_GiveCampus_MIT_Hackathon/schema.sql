PRAGMA foreign_keys = ON;

CREATE TABLE schools (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  school_type TEXT NOT NULL,
  fiscal_year_start_month INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  currency TEXT NOT NULL
);

CREATE TABLE staff (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  region TEXT NOT NULL,
  portfolio_capacity INTEGER,
  active BOOLEAN NOT NULL
);

CREATE TABLE constituents (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  entity_type TEXT NOT NULL,
  preferred_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  primary_email TEXT,
  email_status TEXT NOT NULL,
  phone_status TEXT NOT NULL,
  city TEXT,
  state TEXT,
  country TEXT,
  latitude REAL,
  longitude REAL,
  assigned_staff_id INTEGER REFERENCES staff(id),
  do_not_solicit BOOLEAN NOT NULL,
  deceased BOOLEAN NOT NULL,
  deceased_date TEXT,
  record_source TEXT NOT NULL,
  record_created_at TEXT NOT NULL,
  record_updated_at TEXT NOT NULL
);

CREATE TABLE affiliations (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  constituent_id INTEGER NOT NULL REFERENCES constituents(id),
  affiliation_type TEXT NOT NULL,
  raw_affiliation_value TEXT NOT NULL,
  start_year INTEGER,
  end_year INTEGER,
  is_primary BOOLEAN NOT NULL,
  record_source TEXT NOT NULL
);

CREATE TABLE degrees (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  constituent_id INTEGER NOT NULL REFERENCES constituents(id),
  degree_type TEXT,
  school_or_unit TEXT NOT NULL,
  major TEXT,
  class_year INTEGER,
  start_year INTEGER,
  record_source TEXT NOT NULL
);

CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  constituent_id INTEGER NOT NULL REFERENCES constituents(id),
  activity_type TEXT NOT NULL,
  activity_name TEXT NOT NULL,
  role TEXT,
  start_year INTEGER,
  end_year INTEGER,
  record_source TEXT NOT NULL
);

CREATE TABLE funds (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  fund_code TEXT NOT NULL,
  category TEXT NOT NULL,
  active BOOLEAN NOT NULL
);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  campaign_type TEXT NOT NULL,
  audience_description TEXT NOT NULL,
  goal_type TEXT NOT NULL,
  goal_amount NUMERIC,
  goal_donor_count INTEGER,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL,
  default_fund_id INTEGER NOT NULL REFERENCES funds(id),
  is_recurring_enabled BOOLEAN NOT NULL,
  is_match_or_challenge_active BOOLEAN NOT NULL
);

CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  constituent_id INTEGER NOT NULL REFERENCES constituents(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  fund_id INTEGER REFERENCES funds(id),
  status TEXT NOT NULL,
  expected_ask_amount NUMERIC NOT NULL,
  ask_amount NUMERIC,
  accepted_amount NUMERIC,
  expected_ask_date TEXT NOT NULL,
  ask_date TEXT,
  response_date TEXT,
  closed_at TEXT,
  close_reason TEXT,
  likelihood_band TEXT NOT NULL,
  notes TEXT NOT NULL
);

CREATE TABLE gifts (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  constituent_id INTEGER NOT NULL REFERENCES constituents(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  opportunity_id INTEGER REFERENCES opportunities(id),
  gift_date TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  gift_type TEXT NOT NULL,
  gift_channel TEXT,
  record_source TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  anonymous BOOLEAN NOT NULL,
  fiscal_year INTEGER NOT NULL,
  external_id TEXT,
  linked_parent_gift_id INTEGER REFERENCES gifts(id)
);

CREATE TABLE gift_allocations (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  gift_id INTEGER NOT NULL REFERENCES gifts(id),
  fund_id INTEGER REFERENCES funds(id),
  amount NUMERIC NOT NULL,
  raw_fund_name TEXT NOT NULL
);

CREATE TABLE interactions (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  constituent_id INTEGER NOT NULL REFERENCES constituents(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  occurred_at TEXT NOT NULL,
  interaction_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  purpose TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ask_amount NUMERIC,
  significant BOOLEAN NOT NULL,
  subject TEXT NOT NULL,
  notes TEXT NOT NULL,
  follow_up_date TEXT,
  related_opportunity_id INTEGER REFERENCES opportunities(id),
  related_campaign_id INTEGER REFERENCES campaigns(id),
  related_gift_id INTEGER REFERENCES gifts(id),
  record_source TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  audience_description TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  related_campaign_id INTEGER REFERENCES campaigns(id)
);

CREATE TABLE event_attendance (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  constituent_id INTEGER NOT NULL REFERENCES constituents(id),
  attended_at TEXT NOT NULL,
  record_source TEXT NOT NULL,
  UNIQUE (event_id, constituent_id)
);

CREATE TABLE career_history (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  constituent_id INTEGER NOT NULL REFERENCES constituents(id),
  employer TEXT NOT NULL,
  job_title TEXT,
  industry TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  is_current BOOLEAN NOT NULL,
  recorded_at TEXT NOT NULL,
  record_source TEXT NOT NULL
);

CREATE INDEX idx_affiliations_constituent ON affiliations(constituent_id);
CREATE INDEX idx_degrees_constituent ON degrees(constituent_id);
CREATE INDEX idx_activities_constituent ON activities(constituent_id);
CREATE INDEX idx_gifts_constituent ON gifts(constituent_id);
CREATE INDEX idx_gifts_opportunity ON gifts(opportunity_id);
CREATE INDEX idx_interactions_constituent ON interactions(constituent_id);
CREATE INDEX idx_interactions_opportunity ON interactions(related_opportunity_id);
CREATE INDEX idx_attendance_constituent ON event_attendance(constituent_id);
CREATE INDEX idx_career_constituent ON career_history(constituent_id);
CREATE INDEX idx_opportunities_constituent ON opportunities(constituent_id);
