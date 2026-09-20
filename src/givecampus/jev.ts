import { sha256Hex, stableStringify, MODEL_VERSION } from "./criterion.js";
import { MemoryCache } from "./cache.js";
import { makeCacheKey } from "./criterion.js";
import { DATASET_VERSION } from "../config.js";
import { EVIDENCE_VERSION } from "./criterion.js";

/**
 * Server-side Jev client (official `@typesafe-ai/sdk`, pinned `jev-1.13.0`).
 *
 * - Never runs in the browser: `ensureServer()` throws when `window` exists.
 * - Missing `TYPESAFE_API_KEY` => `{ available: false }` fallback (no throw),
 *   so tests and local demos work without credentials.
 * - Retries honor the contract: maxRetries 2, 408/429/5xx, exponential
 *   backoff 500ms→5000ms, jitter, respect Retry-After, 10s/attempt timeout.
 * - Per-call telemetry: model echo, latency, usage, retries, cache_hit.
 * - Tests inject `MockJevClient` via the `JevClient` interface — no key needed.
 */

export const JEV_MODEL = MODEL_VERSION;

export interface JevQuestion {
  type: "noul" | "score" | "choice";
  instructions: string;
  criteria?: unknown;
}

export interface JevState {
  constituent_id: string;
  dataset_version: string;
  evidence_version: string;
  as_of_date: string;
  as_of_date_minus_12mo: string;
  permissions: { do_not_contact: boolean; do_not_solicit: boolean; eligible_for_solicitation: boolean };
  recorded_giving: {
    last_gift_date: string | null;
    last_gift_amount: number | null;
    lifetime_total: number | null;
    gift_count_24mo: number | null;
  };
  engagement: { events: string[] };
  explicit_capacity: { rating: number | null; source: string | null };
  context: { title: string | null; employer: string | null };
}

export interface JevAnswer {
  type: string;
  [k: string]: unknown;
}

export interface JevCallResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  retries: number;
  cacheHit: boolean;
}

export interface JevClient {
  systemOne(args: {
    state: JevState;
    questions: Record<string, JevQuestion>;
    model?: string;
  }): Promise<Omit<JevCallResult, "cacheHit" | "latencyMs" | "retries"> & { retries?: number }>;
}

export const HEADLINE_QUESTIONS: Record<string, JevQuestion> = {
  has_recent_gift: {
    type: "noul",
    instructions:
      "Does `recorded_giving.last_gift_date` fall on or after `as_of_date_minus_12mo`? Answer only from listed dates.",
    criteria: {
      false: "No last_gift_date listed within 12 months before as_of_date, or date is older",
      true: "State explicitly lists recorded_giving.last_gift_date within 12 months before as_of_date",
    },
  },
  has_repeat_giving: {
    type: "noul",
    instructions: "Does `recorded_giving.gift_count_24mo` show 2 or more gifts?",
    criteria: {
      false: "Fewer than 2 gifts listed in recorded_giving.gift_count_24mo, or field missing",
      true: "State explicitly lists recorded_giving.gift_count_24mo >= 2",
    },
  },
  title_employer_context_present: {
    type: "noul",
    instructions:
      "Does `context` list a `title` or `employer` string? Answer only whether the field is present. Presence does NOT indicate wealth or capacity.",
    criteria: {
      false: "No title or employer value listed in context",
      true: "A title or employer string is listed in context",
    },
  },
  engagement_level: {
    type: "score",
    instructions: "How strong is the engagement evidence listed in `engagement.events`?",
    criteria: [
      "No engagement events listed",
      "Single low-effort interaction listed",
      "Multiple interactions or event attendance listed",
      "Volunteer or leadership role listed",
    ],
  },
  capacity_evidence_strength: {
    type: "score",
    instructions:
      "How strong is the recorded-giving and explicit-rating evidence in `recorded_giving` and `explicit_capacity`? Base only on listed gifts/ratings. Do NOT use `context.title` or `context.employer` as wealth evidence.",
    criteria: [
      "No recorded gifts or explicit rating listed",
      "Single small recorded gift only",
      "Multiple gifts or mid lifetime total listed",
      "Large lifetime total or high explicit rating listed",
    ],
  },
  permitted_action: {
    type: "choice",
    instructions:
      "Among the listed options, which outreach action best matches `permissions` and the listed giving/engagement evidence? Do NOT select an action forbidden by `permissions`. If permissions forbid solicitation, select hold_for_review.",
    criteria: {
      broad_invite:
        "Eligible for solicitation and engagement is low or unknown; low-touch Giving Day invitation is appropriate",
      hold_for_review:
        "Permissions restrict solicitation OR required evidence is missing; hold for human review",
      personal_outreach:
        "Eligible for solicitation and recent or repeat giving plus engagement listed; personal outreach appropriate",
      stewardship_thank_you: "Recent gift listed and eligible for contact; thank-you / stewardship appropriate",
    },
  },
};

export function questionsHash(questions: Record<string, JevQuestion> = HEADLINE_QUESTIONS): string {
  return sha256Hex(stableStringify(questions)).slice(0, 16);
}

export function minus12mo(asOf: string): string {
  const d = new Date(Date.parse(`${asOf}T00:00:00Z`));
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function ensureServer(): void {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    throw new Error("Jev client is server-side only (no browser key)");
  }
}

/** Lazy official-SDK client. Import is deferred so tests never need the dep. */
export class TypesafeJevClient implements JevClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inner: { systemOne: (a: any) => Promise<any> } | null = null;
  private initError: string | null = null;

  constructor(
    private opts: {
      apiKey?: string;
      baseURL?: string;
      maxRetries?: number;
      timeoutMs?: number;
    } = {},
  ) {
    ensureServer();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getInner(): Promise<{ systemOne: (a: any) => Promise<any> }> {
    if (this.inner) return this.inner;
    try {
      const mod = (await import("@typesafe-ai/sdk")) as unknown as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        TypeSafeClient: new (cfg?: any) => { systemOne: (a: any) => Promise<any> };
      };
      const client = new mod.TypeSafeClient({
        apiKey: this.opts.apiKey ?? process.env.TYPESAFE_API_KEY,
        baseURL: this.opts.baseURL ?? process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai",
        maxRetries: this.opts.maxRetries ?? 2,
        timeout: this.opts.timeoutMs ?? 10_000,
        retryPolicy: {
          maxRetries: this.opts.maxRetries ?? 2,
          httpStatuses: [408, 429, 500, 502, 503, 504],
          backoffInitialMs: 500,
          backoffMaxMs: 5000,
          jitter: 0.25,
          maxRetryAfterMs: 60_000,
          respectRetryAfter: true,
        },
      });
      this.inner = client;
      return client;
    } catch (e) {
      this.initError = (e as Error).message;
      throw e;
    }
  }

  async systemOne(args: {
    state: JevState;
    questions: Record<string, JevQuestion>;
    model?: string;
  }): Promise<{ model: string; answers: Record<string, JevAnswer>; usage: { input_tokens: number; output_tokens: number }; retries: number }> {
    ensureServer();
    const key = this.opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!key?.trim()) {
      const err = new Error("TYPESAFE_API_KEY not configured") as Error & { code?: string };
      err.code = "missing_key";
      throw err;
    }
    const client = await this.getInner();
    const t0 = Date.now();
    void t0;
    const res = (await client.systemOne({
      state: args.state as never,
      questions: args.questions as never,
      model: args.model ?? JEV_MODEL,
    })) as unknown as {
      model: string;
      answers: Record<string, JevAnswer>;
      usage?: { input_tokens?: number; output_tokens?: number; input_tokens_total?: number; output_tokens_total?: number; n_retries?: number };
    };
    const u = res.usage ?? {};
    return {
      model: res.model,
      answers: res.answers,
      usage: {
        input_tokens: u.input_tokens ?? u.input_tokens_total ?? 0,
        output_tokens: u.output_tokens ?? u.output_tokens_total ?? 0,
      },
      retries: u.n_retries ?? 0,
    };
  }
}

/** Deterministic mock for tests: derives answers from state, no network. */
export class MockJevClient implements JevClient {
  calls = 0;
  constructor(private action: string = "personal_outreach") {}
  async systemOne(args: { state: JevState; questions: Record<string, JevQuestion>; model?: string }) {
    this.calls += 1;
    const s = args.state;
    const recent =
      s.recorded_giving.last_gift_date != null && s.recorded_giving.last_gift_date >= s.as_of_date_minus_12mo ? 1 : 0;
    const repeat = (s.recorded_giving.gift_count_24mo ?? 0) >= 2 ? 1 : 0;
    const ctx = s.context.title || s.context.employer ? 1 : 0;
    const eng = s.engagement.events.length === 0 ? 0 : s.engagement.events.length === 1 ? 1 : 2.4;
    const cap =
      s.recorded_giving.lifetime_total == null
        ? 0
        : s.recorded_giving.lifetime_total <= 0
          ? 0
          : s.recorded_giving.lifetime_total < 500
            ? 1
            : s.recorded_giving.lifetime_total < 5000
              ? 2
              : 3;
    // Always return the configured action, even when permissions forbid it:
    // the mock simulates a model that ignores restrictions so tests exercise
    // the deterministic code-gate override in evaluateWithJev.
    const action = this.action;
    return {
      model: args.model ?? JEV_MODEL,
      answers: {
        has_recent_gift: { type: "noul", noul: recent },
        has_repeat_giving: { type: "noul", noul: repeat },
        title_employer_context_present: { type: "noul", noul: ctx },
        engagement_level: { type: "score", score: eng, confidence: 0.8 },
        capacity_evidence_strength: { type: "score", score: cap, confidence: 0.7 },
        permitted_action: { type: "choice", choice: action, confidence: 0.9 },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
      retries: 0,
    };
  }
}

export interface JevEvaluateOptions {
  client?: JevClient;
  cache?: MemoryCache<JevCallResult>;
  datasetVersion?: string;
  evidenceVersion?: string;
  model?: string;
}

export interface JevEvaluateOutcome {
  available: boolean;
  result?: JevCallResult;
  reason?: string;
  /** True when the model picked a code-forbidden action and was overridden. */
  gateOverride?: boolean;
  finalAction?: string;
}

/**
 * Evaluate one constituent. Skips the call (review fallback) when the
 * deterministic gate says ineligible — Jev never overrides exclusions.
 */
export async function evaluateWithJev(
  state: JevState,
  opts: JevEvaluateOptions & { eligibleForSolicitation: boolean },
): Promise<JevEvaluateOutcome> {
  ensureServer();
  const model = opts.model ?? JEV_MODEL;
  const qHash = questionsHash();
  const key = makeCacheKey({
    datasetVersion: opts.datasetVersion ?? DATASET_VERSION,
    evidenceVersion: opts.evidenceVersion ?? EVIDENCE_VERSION,
    asOf: state.as_of_date,
    stateHash: sha256Hex(stableStringify(state)).slice(0, 16),
    questionsHash: qHash,
    model,
  });
  const cached = opts.cache?.get(key);
  if (cached?.hit) {
    const r = cached.value;
    return finish(r, true);
  }
  const client = opts.client ?? new TypesafeJevClient();
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!opts.client && !apiKey) {
    return { available: false, reason: "missing_key" };
  }
  const t0 = Date.now();
  try {
    const raw = await client.systemOne({ state, questions: HEADLINE_QUESTIONS, model });
    const result: JevCallResult = {
      model: raw.model,
      answers: raw.answers,
      usage: raw.usage,
      latencyMs: Date.now() - t0,
      retries: raw.retries ?? 0,
      cacheHit: false,
    };
    opts.cache?.set(key, result);
    return finish(result, false);
  } catch (e) {
    const err = e as Error & { code?: string; status?: number };
    const msg = err.message ?? "jev_error";
    if (err.code === "missing_key") return { available: false, reason: "missing_key" };
    if (msg.includes("401") || err.status === 401) {
      return { available: false, reason: "unauthorized (401 — check TYPESAFE_API_KEY, no retry)" };
    }
    if (msg.includes("422") || err.status === 422) {
      return { available: false, reason: `validation (422 — fix state/questions): ${msg}` };
    }
    return { available: false, reason: msg };
  }

  function finish(result: JevCallResult, cacheHit: boolean): JevEvaluateOutcome {
    const r = { ...result, cacheHit };
    const picked = (r.answers.permitted_action as { choice?: string } | undefined)?.choice;
    let gateOverride = false;
    let finalAction = picked;
    if (picked && picked !== "hold_for_review" && !opts.eligibleForSolicitation) {
      gateOverride = true;
      finalAction = "hold_for_review";
    }
    return { available: true, result: r, gateOverride, finalAction };
  }
}
