import { BOOLEAN_COLUMNS, NUMERIC_COLUMNS } from "./config.js";

/**
 * Normalize one CSV field: empty -> null; per-column "true"/"false" -> 1/0.
 *
 * Divergence note (F9): the reference `load_sqlite.py:sqlite_value` maps ANY
 * cell equal to "true"/"false" to 1/0 — including free-text columns such as
 * `notes = "true"`. The TS loader is intentionally stricter: only columns
 * listed in BOOLEAN_COLUMNS are mapped; every other column passes through
 * verbatim so arbitrary text (e.g. notes='true') is never corrupted.
 */
export function normalizeValue(
  table: string,
  column: string,
  value: string | null | undefined,
): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  if (BOOLEAN_COLUMNS[table]?.has(column)) {
    if (value === "true") return 1;
    if (value === "false") return 0;
  }
  if (NUMERIC_COLUMNS[table]?.has(column)) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(
        `Non-finite numeric value for ${table}.${column}: ${JSON.stringify(value)}`,
      );
    }
  }
  return value;
}

/** Convert a money/amount cell to integer cents (throws on non-finite input).
 * Sum cents as integers, then divide by 100 — avoids binary-float drift
 * when totalling USD amounts (F12). */
export function toCents(amount: string | number): number {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) {
    throw new Error(`Non-finite amount: ${JSON.stringify(amount)}`);
  }
  return Math.round(n * 100);
}

/** Integer-cents sum of amount cells, returned as a 2dp number. */
export function sumCents(amounts: readonly (string | number)[]): number {
  return amounts.reduce<number>((s, a) => s + toCents(a), 0) / 100;
}

/** Minimal RFC-4180 CSV row splitter (handles quoted commas/doubled quotes).
 * Unquoted cells are trimmed (surrounding whitespace); quoted cells keep
 * their exact content. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  const quoted: boolean[] = [];
  let cur = "";
  let curQuoted = false;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        curQuoted = true;
      } else if (ch === ",") {
        out.push(curQuoted ? cur : cur.trim());
        quoted.push(curQuoted);
        cur = "";
        curQuoted = false;
      } else cur += ch;
    }
  }
  out.push(curQuoted ? cur : cur.trim());
  quoted.push(curQuoted);
  void quoted;
  return out;
}

export interface ParseCsvOptions {
  /** When set, the header must equal this list exactly (fail-closed on drift). */
  expectedHeader?: readonly string[];
  /** Label used in error messages (usually the CSV file path). */
  sourceLabel?: string;
}

/** Parse full CSV text into header + row dicts. Handles \r\n and multiline quotes.
 * - Strips a leading UTF-8 BOM so the first column name is never corrupted.
 * - Fails closed when a row's width differs from the header width (no silent
 *   drop/pad), and when `expectedHeader` is set and the header differs. */
export function parseCsv(
  text: string,
  opts: ParseCsvOptions = {},
): { header: string[]; rows: Record<string, string>[] } {
  const label = opts.sourceLabel ?? "csv";
  // Split into logical rows respecting quotes.
  const lines: string[] = [];
  let cur = "";
  let inQuotes = false;
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === '"') {
      if (normalized[i + 1] === '"') {
        cur += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        cur += ch;
      }
    } else if (ch === "\n" && !inQuotes) {
      lines.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) lines.push(cur);
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return { header: [], rows: [] };
  const header = splitCsvLine(nonEmpty[0]!);
  if (header.some((h, i) => header.indexOf(h) !== i)) {
    throw new Error(`Duplicate CSV header column in ${label}: ${JSON.stringify(header)}`);
  }
  if (opts.expectedHeader) {
    const want = [...opts.expectedHeader];
    const mismatch =
      want.length !== header.length || want.some((c, i) => c !== header[i]);
    if (mismatch) {
      throw new Error(
        `CSV header mismatch in ${label}: expected [${want.join(",")}] got [${header.join(",")}]`,
      );
    }
  }
  const rows = nonEmpty.slice(1).map((line, idx) => {
    const cells = splitCsvLine(line);
    if (cells.length !== header.length) {
      throw new Error(
        `CSV row-width mismatch in ${label} line ${idx + 2}: expected ${header.length} cells, got ${cells.length}`,
      );
    }
    const rec: Record<string, string> = {};
    header.forEach((h, col) => {
      rec[h] = cells[col] ?? "";
    });
    return rec;
  });
  return { header, rows };
}
