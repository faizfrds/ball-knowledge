import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingest } from "../src/ingest.js";
import { normalizeValue, parseCsv } from "../src/normalize.js";
import { getConstituentBundle } from "../src/data-access.js";
import { resolveDataDir } from "../src/config.js";

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
