/**
 * Isolated OpenAI integration — config only.
 *
 * Scope: `src/llm/*` never touches engine/server/web/benchmark code and
 * never adds dependencies. Transport uses Node 20 native `fetch`.
 *
 * - `OPENAI_MODEL` (default `gpt-5-mini`), `OPENAI_API_KEY` server-only.
 * - Pricing is NEVER hard-coded: estimated-cost fields stay `null` unless
 *   the operator provides explicit per-MTok rates via env.
 */

export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export interface LlmEnv {
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  inputUsdPerMtok: number | null;
  outputUsdPerMtok: number | null;
}

function numOrNull(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function intOr(v: string | undefined, fallback: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function ensureServer(): void {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    throw new Error("OpenAI llm client is server-side only (no browser key)");
  }
}

/** Resolve config from env. Never logs or returns the key itself beyond this struct. */
export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnv {
  const key = env.OPENAI_API_KEY?.trim() ? env.OPENAI_API_KEY.trim() : null;
  const model = env.OPENAI_MODEL?.trim() ? env.OPENAI_MODEL.trim() : DEFAULT_OPENAI_MODEL;
  return {
    apiKey: key,
    model,
    timeoutMs: intOr(env.OPENAI_TIMEOUT_MS, 15_000),
    maxRetries: Math.min(Math.max(intOr(env.OPENAI_MAX_RETRIES, 2), 0), 5),
    inputUsdPerMtok: numOrNull(env.OPENAI_INPUT_USD_PER_MTOK),
    outputUsdPerMtok: numOrNull(env.OPENAI_OUTPUT_USD_PER_MTOK),
  };
}

/** True when a server-side OpenAI key is configured (never leaks the value). */
export function hasOpenAiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") return false;
  return Boolean(env.OPENAI_API_KEY?.trim());
}
