/**
 * Minimal OpenAI Responses API client over Node 20 native `fetch`.
 *
 * - Structured JSON output (`text.format.json_object`); every payload is
 *   parsed with `JSON.parse` in the caller and validated in code.
 * - `fetchFn` is injectable so tests never touch the network.
 * - Timeout per attempt via `AbortController`; retries for transient
 *   failures only: HTTP 408/429/500–599 + network/timeout errors.
 *   400/401/403/404/422 fail fast (no retry).
 * - Telemetry per call: model echo, input/output tokens, latency, retries,
 *   estimated cost (null unless explicit per-MTok rates are configured —
 *   no hard-coded pricing).
 * - Never logs `OPENAI_API_KEY` or request bodies at info level; error
 *   paths redact the key.
 */

import { OPENAI_RESPONSES_URL, ensureServer, resolveLlmEnv, type LlmEnv } from "./config.js";

export type FetchFn = typeof fetch;

export interface StructuredCallOptions {
  system: string;
  user: string;
  /** Extra opaque hints merged into the user payload (already validated). */
  schemaHint?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchFn?: FetchFn;
  url?: string;
  env?: LlmEnv;
}

export interface LlmTelemetry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retries: number;
  estimatedInputUsd: number | null;
  estimatedOutputUsd: number | null;
  estimatedTotalUsd: number | null;
}

export interface StructuredCallResult {
  jsonText: string;
  telemetry: LlmTelemetry;
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryDelayMs(attempt: number, retryAfterMs: number | null): number {
  const base = Math.min(500 * 2 ** attempt, 5000);
  const jitter = base * 0.25 * Math.random();
  const wait = base + jitter;
  if (retryAfterMs != null) return Math.min(Math.max(retryAfterMs, wait), 60_000);
  return wait;
}

function parseRetryAfterMs(h: Headers | null): number | null {
  if (!h) return null;
  const v = h.get("retry-after") ?? h.get("retry-after-ms");
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  // `retry-after` is seconds; `retry-after-ms` is millis. Heuristic: <1000 => seconds.
  return v != null && n < 1000 ? n * 1000 : n;
}

function estimateCost(
  inputTokens: number,
  outputTokens: number,
  env: LlmEnv,
): { estimatedInputUsd: number | null; estimatedOutputUsd: number | null; estimatedTotalUsd: number | null } {
  if (env.inputUsdPerMtok == null && env.outputUsdPerMtok == null) {
    return { estimatedInputUsd: null, estimatedOutputUsd: null, estimatedTotalUsd: null };
  }
  const i = env.inputUsdPerMtok != null ? (inputTokens / 1_000_000) * env.inputUsdPerMtok : null;
  const o = env.outputUsdPerMtok != null ? (outputTokens / 1_000_000) * env.outputUsdPerMtok : null;
  return {
    estimatedInputUsd: i,
    estimatedOutputUsd: o,
    estimatedTotalUsd: i != null || o != null ? (i ?? 0) + (o ?? 0) : null,
  };
}

interface ResponsesApiShape {
  id?: string;
  model?: string;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

function extractJsonText(body: ResponsesApiShape): string {
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;
  const parts: string[] = [];
  for (const item of body.output ?? []) {
    for (const c of item.content ?? []) {
      if ((c.type === "output_text" || c.type === "text") && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

/** One structured-JSON Responses call. Returns raw JSON text + telemetry. */
export async function callStructuredJson(opts: StructuredCallOptions): Promise<StructuredCallResult> {
  ensureServer();
  const env = opts.env ?? resolveLlmEnv();
  // Injected `fetchFn` (tests) never touches the network: allow a placeholder
  // key so mocks run without credentials. Production (native fetch) still
  // requires OPENAI_API_KEY.
  const apiKey = env.apiKey ?? (opts.fetchFn ? "test-key" : null);
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY not configured") as Error & { code?: string };
    err.code = "missing_key";
    throw err;
  }
  const model = opts.model ?? env.model;
  const timeoutMs = opts.timeoutMs ?? env.timeoutMs;
  const maxRetries = opts.maxRetries ?? env.maxRetries;
  const fetchFn: FetchFn = opts.fetchFn ?? fetch;
  const url = opts.url ?? OPENAI_RESPONSES_URL;

  const input = opts.schemaHint ? `${opts.user}\n\n${opts.schemaHint}` : opts.user;
  const payload = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: opts.system }] },
      { role: "user", content: [{ type: "input_text", text: input }] },
    ],
    text: { format: { type: "json_object" } },
  };

  const t0 = Date.now();
  let attempt = 0;
  let lastError: unknown = null;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const body = (await res.json()) as ResponsesApiShape;
        const jsonText = extractJsonText(body);
        if (!jsonText.trim()) throw new Error("empty JSON output from model");
        const usage = body.usage ?? {};
        const inputTokens = Number(usage.input_tokens ?? 0) || 0;
        const outputTokens = Number(usage.output_tokens ?? 0) || 0;
        const cost = estimateCost(inputTokens, outputTokens, env);
        return {
          jsonText,
          telemetry: {
            model: body.model ?? model,
            inputTokens,
            outputTokens,
            latencyMs: Date.now() - t0,
            retries: attempt,
            ...cost,
          },
        };
      }
      const status = res.status;
      const retryAfterMs = parseRetryAfterMs(res.headers ?? null);
      if (TRANSIENT_STATUS.has(status) && attempt < maxRetries) {
        lastError = new Error(`transient openai status ${status}`);
        await sleep(retryDelayMs(attempt, retryAfterMs));
        attempt += 1;
        continue;
      }
      if (status === 401 || status === 403) throw new Error(`unauthorized (${status} — check OPENAI_API_KEY, no retry)`);
      if (status === 422 || status === 400 || status === 404) throw new Error(`request rejected (${status} — no retry)`);
      throw new Error(`openai request failed (${status} — no retry)`);
    } catch (e) {
      clearTimeout(timer);
      const err = e as Error & { name?: string; code?: string };
      const msg = String(err?.message ?? e);
      // Fail-fast errors (auth/validation) already thrown above: rethrow as-is.
      if (/no retry/.test(msg) || (err as { code?: string })?.code === "missing_key") throw e;
      const transient = err?.name === "AbortError" || err?.name === "TimeoutError" || msg.includes("transient openai status") || msg.includes("fetch failed") || msg.includes("network");
      if (transient && attempt < maxRetries) {
        lastError = e;
        await sleep(retryDelayMs(attempt, null));
        attempt += 1;
        continue;
      }
      if (transient) throw new Error(`openai call failed after ${attempt} retries: ${msg}`);
      throw e;
    }
  }
  void lastError;
}
