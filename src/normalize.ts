import { BOOLEAN_COLUMNS } from "./config.js";

/** Normalize one CSV field: empty -> null; booleans "true"/"false" -> 1/0. */
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
  return value;
}

/** Minimal RFC-4180 CSV row splitter (handles quoted commas/doubled quotes). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
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
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Parse full CSV text into header + row dicts. Handles \r\n and multiline quotes. */
export function parseCsv(
  text: string,
): { header: string[]; rows: Record<string, string>[] } {
  // Split into logical rows respecting quotes.
  const lines: string[] = [];
  let cur = "";
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, "\n");
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
  const rows = nonEmpty.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      rec[h] = cells[idx] ?? "";
    });
    return rec;
  });
  return { header, rows };
}
