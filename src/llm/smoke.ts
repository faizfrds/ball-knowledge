/**
 * Safe live smoke: one minimal structured-JSON call proving model + key +
 * token telemetry work end-to-end. Reads `.env.local` via `src/env.ts`
 * (real env wins), never logs the key or private inputs — output is only
 * `{ ok, model, inputTokens, outputTokens, latencyMs, retries }`.
 *
 * Run without committing credentials:
 *   npx tsx src/llm/smoke.ts
 */

import { loadServerEnv } from "../env.js";
import { callStructuredJson } from "./client.js";
import { resolveLlmEnv } from "./config.js";

export interface LlmSmokeResult {
  ok: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retries: number;
}

export async function runLlmSmoke(): Promise<LlmSmokeResult> {
  loadServerEnv();
  const env = resolveLlmEnv();
  if (!env.apiKey) throw new Error("OPENAI_API_KEY not configured (see .env.local)");
  const { telemetry } = await callStructuredJson({
    system: 'Return JSON only: {"ok": true}.',
    user: '{"ping": true}',
    env,
  });
  return {
    ok: true,
    model: telemetry.model,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    latencyMs: telemetry.latencyMs,
    retries: telemetry.retries,
  };
}

const invokedDirectly =
  process.argv[1] != null && /src[\\/]llm[\\/]smoke\.ts$/.test(process.argv[1]);

if (invokedDirectly) {
  runLlmSmoke()
    .then((r) => {
      console.log(
        JSON.stringify({ ok: r.ok, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, latencyMs: r.latencyMs, retries: r.retries }),
      );
    })
    .catch((e) => {
      console.error(JSON.stringify({ ok: false, error: (e as Error).message }));
      process.exit(1);
    });
}
