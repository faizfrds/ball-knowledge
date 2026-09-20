import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSchemaPath } from "../../src/config.js";

/** File-backed fixture DB (shared across connections, e.g. API smoke tests). */
export function buildFixtureDbFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gc-")), "fixture.sqlite");
  const db = new Database(file);
  seed(db);
  db.close();
  return file;
}

/** In-memory fixture DB (single-connection unit/integration tests). */
export function buildFixtureDbMemory(): Database.Database {
  const db = new Database(":memory:");
  seed(db);
  return db;
}

function seed(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(resolveSchemaPath(), "utf8"));
  db.pragma("foreign_keys = ON");
  db.exec(`INSERT INTO schools (id, name, school_type, fiscal_year_start_month, timezone, currency)
    VALUES (1, 'GiveCampus University', 'university', 7, 'UTC', 'USD')`);
  db.exec(`INSERT INTO staff (id, school_id, display_name, role, region, portfolio_capacity, active)
    VALUES (1, 1, 'Test Officer', 'officer', 'east', 100, 1)`);

  const addConstituent = db.prepare(`INSERT INTO constituents
    (id, school_id, entity_type, preferred_name, first_name, last_name, primary_email,
     email_status, phone_status, city, state, country, latitude, longitude,
     assigned_staff_id, do_not_solicit, deceased, deceased_date,
     record_source, record_created_at, record_updated_at)
    VALUES (@id, 1, @entity_type, @name, 'A', 'B', 'a@example.edu',
     @email, @phone, @city, @state, 'USA', NULL, NULL,
     1, @dnc, @deceased, @deceased_date, 'test', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`);
  const C = (
    id: number,
    o: Partial<{
      entity_type: string; name: string; email: string; phone: string;
      city: string | null; state: string | null; dnc: number; deceased: number;
      deceased_date: string | null;
    }>,
  ) =>
    addConstituent.run({
      id,
      entity_type: o.entity_type ?? "individual",
      name: o.name ?? `Person ${id}`,
      email: o.email ?? "deliverable",
      phone: o.phone ?? "available",
      city: o.city ?? "Boston",
      state: o.state ?? "MA",
      dnc: o.dnc ?? 0,
      deceased: o.deceased ?? 0,
      deceased_date: o.deceased_date ?? null,
    });

  C(1, { name: "Healthy Donor" }); // solicit-eligible donor
  C(2, { name: "Deceased Donor", deceased: 1, deceased_date: "2020-05-01" });
  C(3, { name: "Future Deceased", deceased: 1, deceased_date: "2027-01-01" });
  C(4, { name: "Suppressed", dnc: 1 });
  C(5, { name: "Unreachable", email: "missing", phone: "missing" });
  C(6, { name: "Phone Only", email: "do_not_email", phone: "available" });
  C(7, { name: "Student Sam" });
  C(8, { name: "No Affiliation" });
  C(9, { name: "Recurring Rita" });
  C(10, { name: "Cold Casey", city: null, state: null, email: "deliverable", phone: "missing" });

  const addAffil = db.prepare(`INSERT INTO affiliations
    (id, school_id, constituent_id, affiliation_type, raw_affiliation_value, start_year, end_year, is_primary, record_source)
    VALUES (@id, 1, @cid, @type, @type, NULL, NULL, 1, 'test')`);
  let aid = 1;
  for (const cid of [1, 2, 3, 4, 5, 6, 7, 9, 10]) {
    addAffil.run({ id: aid++, cid, type: cid === 7 ? "student" : "alumni" });
  }
  // Constituent 8 intentionally has NO affiliation row (500-row gap case).

  const addDegree = db.prepare(`INSERT INTO degrees
    (id, school_id, constituent_id, degree_type, school_or_unit, major, class_year, start_year, record_source)
    VALUES (@id, 1, @cid, @dtype, 'Arts', 'History', @year, NULL, 'test')`);
  addDegree.run({ id: 1, cid: 1, dtype: "B.A.", year: 2010 });
  addDegree.run({ id: 2, cid: 7, dtype: "B.A.", year: 2027 });
  addDegree.run({ id: 3, cid: 9, dtype: "B.S.", year: 2015 });

  const addGift = db.prepare(`INSERT INTO gifts
    (id, school_id, constituent_id, campaign_id, opportunity_id, gift_date, amount, currency,
     status, gift_type, gift_channel, record_source, payment_method, anonymous, fiscal_year, external_id, linked_parent_gift_id)
    VALUES (@id, 1, @cid, NULL, NULL, @date, @amount, 'USD', @status, @gtype, 'online', 'test', 'card', 0, 2025, NULL, @parent)`);
  // Healthy donor: two paid gifts, latest within 90d of 2026-08-31.
  addGift.run({ id: 1, cid: 1, date: "2025-06-01", amount: 100, status: "paid", gtype: "one_time", parent: null });
  addGift.run({ id: 2, cid: 1, date: "2026-08-01", amount: 250, status: "paid", gtype: "one_time", parent: null });
  // Deceased donor: large historical giving (still visible, never ranked).
  addGift.run({ id: 3, cid: 2, date: "2019-01-01", amount: 50000, status: "paid", gtype: "one_time", parent: null });
  // Future-deceased: gift before T0.
  addGift.run({ id: 4, cid: 3, date: "2025-01-01", amount: 75, status: "paid", gtype: "one_time", parent: null });
  // Phone-only: paid history.
  addGift.run({ id: 5, cid: 6, date: "2025-03-01", amount: 500, status: "paid", gtype: "one_time", parent: null });
  // No-affiliation: paid history (must be retained via LEFT JOIN).
  addGift.run({ id: 6, cid: 8, date: "2025-04-01", amount: 300, status: "paid", gtype: "one_time", parent: null });
  // Recurring trap: parent header $12k + 12x$1k installments => paid basis $12k, count 12.
  addGift.run({ id: 7, cid: 9, date: "2024-01-01", amount: 12000, status: "pledged", gtype: "recurring_parent", parent: null });
  for (let m = 0; m < 12; m++) {
    const mm = String(m + 1).padStart(2, "0");
    addGift.run({ id: 10 + m, cid: 9, date: `2024-${mm}-05`, amount: 1000, status: "paid", gtype: "installment", parent: 7 });
  }
  // Pledged distractor (never counts as paid).
  addGift.run({ id: 30, cid: 1, date: "2026-07-01", amount: 10000, status: "pledged", gtype: "pledge", parent: null });

  const addInter = db.prepare(`INSERT INTO interactions
    (id, school_id, constituent_id, staff_id, occurred_at, interaction_type, direction,
     purpose, outcome, ask_amount, significant, subject, notes, follow_up_date,
     related_opportunity_id, related_campaign_id, related_gift_id, record_source)
    VALUES (@id, 1, @cid, 1, @at, 'email', @dir, @purpose, @outcome, NULL, 0, 's', 'n', @follow, NULL, NULL, @gift, 'test')`);
  addInter.run({ id: 1, cid: 1, at: "2026-07-15T10:00:00Z", dir: "outbound", purpose: "cultivation", outcome: "connected", follow: null, gift: null });
  // Overdue follow-up for constituent 10.
  addInter.run({ id: 2, cid: 10, at: "2026-06-01T10:00:00Z", dir: "outbound", purpose: "cultivation", outcome: "connected", follow: "2026-06-15", gift: null });

  // Future event (invite path; zero attendance by design).
  db.exec(`INSERT INTO events (id, school_id, name, event_type, starts_at, ends_at, city, state,
    latitude, longitude, audience_description, capacity, related_campaign_id)
    VALUES (1, 1, 'Giving Day Rally', 'rally', '2026-09-15T18:00:00Z', '2026-09-15T20:00:00Z',
    'Boston', 'MA', 42.3, -71.0, 'alumni', 500, NULL)`);

  // Career rows: one current (recorded before T0), one future-recorded (leakage probe).
  const addCareer = db.prepare(`INSERT INTO career_history
    (id, school_id, constituent_id, employer, job_title, industry, started_at, ended_at, is_current, recorded_at, record_source)
    VALUES (@id, 1, @cid, @emp, @title, 'tech', @started, NULL, @cur, @recorded, 'test')`);
  addCareer.run({ id: 1, cid: 1, emp: "Acme Corp", title: "Program Manager", started: "2020-01-01", cur: 1, recorded: "2024-05-01T00:00:00Z" });
  addCareer.run({ id: 2, cid: 1, emp: "Acme Corp", title: "Vice President", started: "2025-06-01", cur: 1, recorded: "2025-09-15T00:00:00Z" });

  db.exec(`INSERT INTO activities (id, school_id, constituent_id, activity_type, activity_name, role, start_year, end_year, record_source)
    VALUES (1, 1, 1, 'club', 'Alumni Mentors', 'member', 2020, NULL, 'test')`);
}
