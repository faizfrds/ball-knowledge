/**
 * Job 2 — explain only the final top <=20 ranked items.
 *
 * - Single batched LLM call for the whole list. NEVER per candidate.
 * - Code enforces: `items.length <= 20` (throws otherwise), IDs preserved,
 *   reasons are one line (<=280 chars, no newlines), each reason cites at
 *   least one caller-supplied evidence ref.
 * - Unsupported claims are filtered in code: probability / expected-revenue
 *   / capacity-from-title / send-time / household language is replaced with
 *   a safe evidence-bound template. The model never gets to invent row IDs:
 *   refs must come from the caller-supplied set.
 */

import { callStructuredJson, type FetchFn, type LlmTelemetry } from "./client.js";

export const MAX_EXPLAIN_ITEMS = 20;
export const MAX_REASON_CHARS = 280;

export interface ExplainItem {
  id: string | number;
  name?: string;
  action?: string;
  evidenceRefs: string[];
  evidenceText?: string[];
}

export interface ItemExplanation {
  id: string | number;
  reason: string;
}

export interface ExplainOutcome {
  explanations: ItemExplanation[];
  telemetry: LlmTelemetry | null;
  filtered: number;
}

const EVIDENCE_REF_RE = /(gifts?|interactions?|event_attendance|events|career_history|degrees|activities|constituents)\s*:\s*\S+/i;

const BANNED_CLAIM_RES = [
  /%?\s*likely to give/i,
  /propensity/i,
  /probabilit/i,
  /expected (revenue|value|\$)/i,
  /projected/i,
  /\$\s*[\d,]+.*(expected|projected|will give)/i,
  /can give \$/i,
  /(vp|chief|president|partner|founder|director)\s*(=>|means|proves|indicates).*\$?/i,
  /best time to (call|give|contact)/i,
  /household|spouse|influence/i,
  /ai-?verified|validated model/i,
  /top donor/i,
];

export function containsBannedClaim(reason: string): boolean {
  return BANNED_CLAIM_RES.some((re) => re.test(reason));
}

function safeReason(item: ExplainItem): string {
  const refs = item.evidenceRefs.slice(0, 4).join(", ");
  const action = item.action ? ` Action: ${String(item.action).slice(0, 40)}.` : "";
  return `Held for review — evidence: ${refs}.${action}`.slice(0, MAX_REASON_CHARS);
}

/** Code-side validator/repair for one model-produced reason. */
export function validateReason(item: ExplainItem, raw: unknown): { reason: string; filtered: boolean } {
  let reason = typeof raw === "string" ? raw : "";
  reason = reason.replace(/\s+/g, " ").trim();
  const refsOk = EVIDENCE_REF_RE.test(reason) && item.evidenceRefs.some((r) => reason.includes(String(r)));
  const asciiSafe = reason.length > 0 && reason.length <= MAX_REASON_CHARS && !reason.includes("\n");
  if (!asciiSafe || !refsOk || containsBannedClaim(reason)) {
    return { reason: safeReason(item), filtered: true };
  }
  return { reason, filtered: false };
}

const SYSTEM_PROMPT = [
  "You write one-line evidence-grounded reasons for a fundraising worklist.",
  "Output JSON only: { \"explanations\": [ { \"id\": <id>, \"reason\": <string> } ] }.",
  `Rules: at most ${MAX_EXPLAIN_ITEMS} items; one line per reason (<=${MAX_REASON_CHARS} chars, no newlines).`,
  "Each reason MUST cite at least one of the caller-supplied evidence refs verbatim (e.g. gifts:123).",
  "Never invent row IDs, amounts, dates, or refs. Never claim probabilities, expected revenue, capacity from title/employer, best send time, households, or validation.",
  "Title/employer is weak context only. Missing data must be stated, never hidden.",
].join("\n");

/**
 * Explain the final ranked list in ONE batched call. Throws when
 * `items.length > 20` (caller must page first). Per-item failures are
 * repaired to the safe template — the call itself never throws for
 * content reasons (transport errors propagate).
 */
export async function explainRanked(
  items: ExplainItem[],
  opts: { model?: string; fetchFn?: FetchFn; timeoutMs?: number; maxRetries?: number } = {},
): Promise<ExplainOutcome> {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  if (items.length === 0) return { explanations: [], telemetry: null, filtered: 0 };
  if (items.length > MAX_EXPLAIN_ITEMS) {
    throw new Error(`explain only the final top ${MAX_EXPLAIN_ITEMS} (got ${items.length})`);
  }
  for (const it of items) {
    if (!Array.isArray(it.evidenceRefs) || it.evidenceRefs.length === 0) {
      throw new Error(`item ${String(it.id)} needs at least one evidence ref`);
    }
  }
  if (!opts.fetchFn) {
    const { resolveLlmEnv } = await import("./config.js");
    if (!resolveLlmEnv().apiKey) throw new Error("OPENAI_API_KEY not configured");
  }
  const compact = items.map((it) => ({
    id: it.id,
    name: it.name?.slice(0, 80),
    action: it.action?.slice(0, 40),
    evidenceRefs: it.evidenceRefs.slice(0, 12),
    evidenceText: (it.evidenceText ?? []).slice(0, 8).map((s) => String(s).slice(0, 200)),
  }));
  const { jsonText, telemetry } = await callStructuredJson({
    system: SYSTEM_PROMPT,
    user: JSON.stringify({ items: compact }),
    model: opts.model,
    fetchFn: opts.fetchFn,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      explanations: items.map((it) => ({ id: it.id, reason: safeReason(it) })),
      telemetry,
      filtered: items.length,
    };
  }
  const byId = new Map<string, ExplainItem>(items.map((it) => [String(it.id), it]));
  const list = (parsed as { explanations?: unknown }).explanations;
  const out: ItemExplanation[] = [];
  let filtered = 0;
  if (Array.isArray(list)) {
    for (const e of list) {
      const rec = e as { id?: unknown; reason?: unknown };
      const item = byId.get(String(rec.id));
      if (!item) continue; // ignore invented IDs
      const v = validateReason(item, rec.reason);
      if (v.filtered) filtered += 1;
      out.push({ id: item.id, reason: v.reason });
    }
  }
  // Preserve caller order; fill gaps (missing/invented IDs) with safe template.
  const seen = new Set(out.map((e) => String(e.id)));
  const ordered: ItemExplanation[] = [];
  for (const it of items) {
    const hit = out.find((e) => String(e.id) === String(it.id));
    if (hit) ordered.push(hit);
    else {
      ordered.push({ id: it.id, reason: safeReason(it) });
      filtered += 1;
    }
  }
  void seen;
  return { explanations: ordered, telemetry, filtered };
}
