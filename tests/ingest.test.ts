import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingest, checkAllocationSums, orderGiftsRowsForInsert } from "../src/ingest.js";
import { normalizeValue, parseCsv, sumCents, toCents } from "../src/normalize.js";
import {
  assertAsOf,
  getAttendanceForConstituent,
  getConstituentBundle,
  listConstituents,
  listConstituentsPaged,
} from "../src/data-access.js";
import { openDb, tableCount } from "../src/db.js";
import { REFERENCE_DIR, resolveDataDir } from "../src/config.js";

describe("normalizeValue", () => {
  it("maps empty -> null and booleans -> 1/0", () => {
    expect(normalizeValue("constituents", "city", "")).toBeNull();
    expect(normalizeValue("constituents", "deceased", "true")).toBe(1);
    expect(normalizeValue("constituents", "deceased", "false")).toBe(0);
    expect(normalizeValue("gifts", "campaign_id", "")).toBeNull();
    expect(normalizeValue("gifts", "gift_channel", "")).toBeNull();
    // Non-boolean columns pass through verbatim.
    expect(normalizeValue("gifts", "status", "paid")).toBe("paid");
  });
});

describe("parseCsv", () => {
  it("handles quoted commas and preserves header order", () => {
    const { header, rows } = parseCsv('id,notes\n1,"a, b"\n2,plain\n');
    expect(header).toEqual(["id", "notes"]);
    expect(rows[0]!.notes).toBe("a, b");
    expect(rows).toHaveLength(2);
  });
});

describe("ingest (reference data, read-only source)", () => {
  it("loads all 15 tables into a temp DB preserving source IDs", () => {
    const dataDir = resolveDataDir();
    expect(fs.existsSync(path.join(dataDir, "constituents.csv"))).toBe(true);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ball-knowledge-"));
    const dbPath = path.join(tmp, "test.sqlite");
    const result = ingest({ dbPath, force: true });
    expect(result.counts.constituents).toBe(20000);
    expect(result.counts.gifts).toBe(22330);
    const db = new Database(dbPath, { readonly: true });
    try {
      const minMax = db
        .prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS n FROM gifts`)
        .get() as { lo: number; hi: number; n: number };
      expect(minMax.n).toBe(22330);
      // IDs preserved (1..N contiguous in generator output).
      expect(minMax.lo).toBe(1);
      // Spot-check: empty CSV fields became NULL, not "".
      const nulls = db
        .prepare(`SELECT COUNT(*) AS n FROM gifts WHERE campaign_id IS NULL`)
        .get() as { n: number };
      expect(nulls.n).toBeGreaterThan(0);
      const emptyStrings = db
        .prepare(`SELECT COUNT(*) AS n FROM gifts WHERE campaign_id = ''`)
        .get() as { n: number };
      expect(emptyStrings.n).toBe(0);
      // Bundle smoke test with evidence on a real constituent.
      const bundle = getConstituentBundle(db, 1);
      expect(bundle.features.constituentId).toBe(1);
      expect(bundle.features.asOf).toBe("2026-08-31");
      expect(bundle.features.evidence[0]).toEqual({ table: "constituents", id: 1 });
    } finally {
      db.close();
    }
  }, 120_000);
});

describe("ingestion hardening (F7/F8/F9/F12/F14/F2)", () => {
  it("strips BOM and trims unquoted whitespace but preserves quoted text", () => {
    const { header, rows } = parseCsv('\uFEFFid,notes\n1,  padded  \n2,"  kept  "\n');
    expect(header).toEqual(["id", "notes"]);
    expect(rows[0]!.notes).toBe("padded");
    expect(rows[1]!.notes).toBe("  kept  ");
  });

  it("fails closed on header drift and row-width mismatch", () => {
    expect(() =>
      parseCsv("id,name\n1,a\n", { expectedHeader: ["id", "other"], sourceLabel: "t.csv" }),
    ).toThrow(/header mismatch/);
    expect(() => parseCsv("id,name\n1,a,b\n", { sourceLabel: "t.csv" })).toThrow(
      /row-width mismatch/,
    );
    expect(() => parseCsv("id,name\n1\n", { sourceLabel: "t.csv" })).toThrow(
      /row-width mismatch/,
    );
  });

  it("never maps arbitrary 'true' text in non-boolean columns", () => {
    expect(normalizeValue("opportunities", "notes", "true")).toBe("true");
    expect(normalizeValue("interactions", "subject", "false")).toBe("false");
    expect(normalizeValue("constituents", "deceased", "true")).toBe(1);
  });

  it("rejects non-finite numerics and sums money via integer cents", () => {
    expect(() => normalizeValue("gifts", "amount", "NaN")).toThrow(/Non-finite numeric/);
    expect(() => normalizeValue("gifts", "amount", "abc")).toThrow(/Non-finite numeric/);
    expect(() => toCents("abc")).toThrow(/Non-finite amount/);
    expect(toCents("19.99")).toBe(1999);
    // Binary-float trap: 0.1 + 0.2 must be exactly 0.30 via cents.
    expect(sumCents([0.1, 0.2])).toBe(0.3);
  });

  it("refuses an output DB inside the reference tree", () => {
    const inside = path.join(REFERENCE_DIR, "data", "evil.sqlite");
    expect(() => ingest({ dbPath: inside, force: true })).toThrow(/reference\/source tree/);
  });

  it("failed ingest never touches the existing DB and cleans temp sidecars", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ball-knowledge-atomic-"));
    const dest = path.join(tmp, "keep.sqlite");
    fs.writeFileSync(dest, "sentinel");
    const badDataDir = path.join(tmp, "empty-data");
    fs.mkdirSync(badDataDir, { recursive: true });
    expect(() => ingest({ dataDir: badDataDir, dbPath: dest, force: true })).toThrow();
    expect(fs.readFileSync(dest, "utf-8")).toBe("sentinel");
    const leftovers = fs.readdirSync(tmp).filter((f) => f.includes("keep.sqlite.tmp."));
    expect(leftovers).toEqual([]);
  });

  it("orders gift parents before children for the self-FK", () => {
    const rows = [
      { id: "3", linked_parent_gift_id: "1" },
      { id: "1", linked_parent_gift_id: "" },
      { id: "2", linked_parent_gift_id: "1" },
    ];
    expect(orderGiftsRowsForInsert(rows).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("detects allocation sums that drift by more than a cent", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        `CREATE TABLE gifts (id INTEGER PRIMARY KEY, amount NUMERIC NOT NULL);
         CREATE TABLE gift_allocations (id INTEGER PRIMARY KEY, gift_id INTEGER NOT NULL REFERENCES gifts(id), amount NUMERIC NOT NULL);`,
      );
      db.exec(
        `INSERT INTO gifts (id, amount) VALUES (1, 100.00), (2, 50.00);
         INSERT INTO gift_allocations (id, gift_id, amount) VALUES (1, 1, 60.00), (2, 1, 40.00), (3, 2, 49.00);`,
      );
      expect(checkAllocationSums(db)).toBe(1);
      db.exec(`UPDATE gift_allocations SET amount = 50.00 WHERE id = 3`);
      expect(checkAllocationSums(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects invalid and future as-of dates before any SQL runs", () => {
    expect(() => assertAsOf("foo")).toThrow(/invalid_asof/);
    expect(() => assertAsOf("2099-01-01")).toThrow(/future_asof/);
    expect(() => assertAsOf("2026-08-31")).not.toThrow();
  });

  it("enforces the attendance as-of cutoff in SQL", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        `CREATE TABLE event_attendance (id INTEGER PRIMARY KEY, constituent_id INTEGER NOT NULL, attended_at TEXT NOT NULL);`,
      );
      db.exec(
        `INSERT INTO event_attendance (id, constituent_id, attended_at) VALUES
         (1, 1, '2026-08-01T10:00:00Z'), (2, 1, '2026-09-05T10:00:00Z');`,
      );
      const rows = getAttendanceForConstituent(db, 1, "2026-08-31");
      expect(rows.map((r) => r.id)).toEqual([1]);
      expect(() => getAttendanceForConstituent(db, 1, "2099-01-01")).toThrow(/future_asof/);
    } finally {
      db.close();
    }
  });

  it("clamps pagination and projects/total via the paged list", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        `CREATE TABLE constituents (id INTEGER PRIMARY KEY, preferred_name TEXT, entity_type TEXT, email_status TEXT, phone_status TEXT, city TEXT, state TEXT);`,
      );
      db.exec(
        `INSERT INTO constituents (id, preferred_name, entity_type, email_status, phone_status, city, state) VALUES
         (1, 'A', 'individual', 'deliverable', 'available', 'Boston', 'MA'),
         (2, 'B', 'individual', 'unknown', 'unknown', 'Boston', 'MA');`,
      );
      expect(() => listConstituents(db, { limit: NaN })).toThrow(/invalid_pagination/);
      expect(() => listConstituents(db, { limit: 0 })).toThrow(/invalid_pagination/);
      expect(() => listConstituents(db, { offset: -1 })).toThrow(/invalid_pagination/);
      const page = listConstituentsPaged(db, { limit: 1, offset: 1 });
      expect(page.total).toBe(2);
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).not.toHaveProperty("primary_email");
      expect(() => listConstituentsPaged(db, { columns: ["primary_email"] })).toThrow(
        /invalid_projection/,
      );
    } finally {
      db.close();
    }
  });

  it("openDb refuses to auto-create missing files in readonly mode; tableCount allowlists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ball-knowledge-db-"));
    expect(() => openDb(path.join(tmp, "missing.sqlite"), { readonly: true })).toThrow(
      /not found/,
    );
    const db = new Database(":memory:");
    try {
      expect(() => tableCount(db, "constituents; DROP TABLE x;")).toThrow(/Unknown table/);
    } finally {
      db.close();
    }
  });
});
