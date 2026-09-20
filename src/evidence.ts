import type { EvidenceRef } from "./features.js";

/** Compact source pointer, e.g. "gifts:123". Every feature bundle carries these. */
export function formatSourceRef(ref: EvidenceRef): string {
  return `${ref.table}:${ref.id}`;
}

export function formatEvidence(refs: EvidenceRef[]): string[] {
  return refs.map(formatSourceRef);
}

export interface EvidenceBundle {
  asOf: string;
  refs: EvidenceRef[];
  /** Human-readable pointers for demo/debugging (derived, not stored). */
  display: string[];
}

export function buildEvidenceBundle(asOf: string, refs: EvidenceRef[]): EvidenceBundle {
  return { asOf, refs, display: formatEvidence(refs) };
}
