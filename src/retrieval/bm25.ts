/** Small, dependency-free BM25 ranker for retrieval candidate selection. */

export type RetrievalId = string | number;

export interface TextDocument {
  id: RetrievalId;
  text: string;
}

export interface RankedDocument {
  id: RetrievalId;
  score: number;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function compareIds(a: RetrievalId, b: RetrievalId): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en");
}

/** Return only documents with at least one query-term match. Ties are stable. */
export function rankBm25(
  query: string,
  documents: readonly TextDocument[],
  options: Bm25Options = {},
): RankedDocument[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || documents.length === 0) return [];
  const k1 = options.k1 ?? 1.5;
  const b = options.b ?? 0.75;
  if (!Number.isFinite(k1) || k1 <= 0 || !Number.isFinite(b) || b < 0 || b > 1) {
    throw new Error("Invalid BM25 parameters");
  }

  const rows = documents.map((document) => {
    const tokens = tokenize(document.text);
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    return { id: document.id, length: tokens.length, frequencies };
  });
  const averageLength = rows.reduce((sum, row) => sum + row.length, 0) / rows.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(term, rows.reduce((count, row) => count + Number(row.frequencies.has(term)), 0));
  }

  return rows
    .map((row) => {
      let score = 0;
      for (const term of terms) {
        const tf = row.frequencies.get(term) ?? 0;
        if (tf === 0) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5));
        const norm = tf + k1 * (1 - b + b * (row.length / averageLength));
        score += idf * ((tf * (k1 + 1)) / norm);
      }
      return { id: row.id, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
}
