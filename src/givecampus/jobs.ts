import type Database from "better-sqlite3";
import { buildWorklist, type WorklistResult } from "./worklist.js";
import type { JevClient } from "./jev.js";
import {
  MAX_EXPLAIN_ITEMS,
  explainRanked,
  type ExplainItem,
  type ItemExplanation,
} from "../llm/explain.js";
import type { FetchFn } from "../llm/client.js";
import { resolveLlmEnv } from "../llm/config.js";

/**
 * Background-ish worklist jobs for the proposed UI.
 *
 * Single-process prototype: jobs run in slices on the event loop
 * (`setImmediate` chunks) so polling stays responsive. API shape
 * (POST jobs → GET job polling → result + cost receipt) matches what a
 * worker-backed implementation would expose, so the UI will not churn.
 */

export type JobStatus = "queued" | "running" | "done" | "error";

export interface WorklistJob {
  id: string;
  status: JobStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  filter: unknown;
  criterion: unknown;
  enrichWithJev: boolean;
  explainTop: boolean;
  result?: WorklistResult;
  /** One-line evidence-grounded reasons for the final top<=20 (rank order preserved). */
  explanations?: ItemExplanation[];
  llm?: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    model: string | null;
    fallback: boolean;
    filtered: number;
  };
  error?: string;
}

let seq = 0;
const jobs = new Map<string, WorklistJob>();

function nextId(): string {
  seq += 1;
  return `wl-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function createJob(
  filter: unknown,
  criterion: unknown,
  enrichWithJev: boolean,
  explainTop = false,
): WorklistJob {
  const now = new Date().toISOString();
  const job: WorklistJob = {
    id: nextId(),
    status: "queued",
    progress: 0,
    createdAt: now,
    updatedAt: now,
    filter,
    criterion,
    enrichWithJev,
    explainTop,
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): WorklistJob | undefined {
  return jobs.get(id);
}

export function listJobs(): WorklistJob[] {
  return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 50);
}

export function clearJobs(): void {
  jobs.clear();
  seq = 0;
}

/** Run a job in the background (event-loop slices); resolves when done. */
export function runJob(
  db: Database.Database,
  jobId: string,
  opts: { jevClient?: JevClient; fetchFn?: FetchFn; llmModel?: string } = {},
): Promise<WorklistJob> {
  const job = jobs.get(jobId);
  if (!job) return Promise.reject(new Error(`job not found: ${jobId}`));
  if (job.status === "running" || job.status === "done") return Promise.resolve(job);
  job.status = "running";
  job.progress = 0.05;
  job.updatedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const step = () => {
      job.progress = Math.min(0.9, job.progress + 0.2);
      job.updatedAt = new Date().toISOString();
      if (job.progress < 0.9) {
        setImmediate(step);
        return;
      }
      buildWorklist(db, job.filter, job.criterion ?? undefined, {
        jevClient: opts.jevClient,
        enrichWithJev: job.enrichWithJev,
      })
        .then(async (result) => {
          job.status = "done";
          job.progress = 1;
          job.result = result;
          if (job.explainTop) {
            const explained = await explainTopEntries(result, {
              fetchFn: opts.fetchFn,
              model: opts.llmModel,
            });
            job.explanations = explained.explanations;
            job.llm = explained.llm;
            result.receipt.llmCalls = explained.llm.calls;
            result.receipt.llmInputTokens = explained.llm.inputTokens;
            result.receipt.llmOutputTokens = explained.llm.outputTokens;
            result.receipt.llmModel = explained.llm.model;
            result.receipt.llmFallback = explained.llm.fallback;
          }
          job.updatedAt = new Date().toISOString();
          resolve(job);
        })
        .catch((e) => {
          job.status = "error";
          job.error = (e as Error).message;
          job.updatedAt = new Date().toISOString();
          resolve(job);
        });
    };
    setImmediate(step);
  });
}

/**
 * Explain the final top<=20 entries in one batched call. The LLM sees
 * only the top slice (never the full worklist). Missing key / transport
 * failure degrades to the safe evidence-bound template (fallback: true).
 */
export async function explainTopEntries(
  result: WorklistResult,
  opts: { fetchFn?: FetchFn; model?: string } = {},
): Promise<{
  explanations: ItemExplanation[];
  llm: NonNullable<WorklistJob["llm"]>;
}> {
  const top = result.entries.slice(0, MAX_EXPLAIN_ITEMS);
  const items: ExplainItem[] = top.map((e) => ({
    id: e.constituentId,
    name: e.name,
    action: e.action,
    evidenceRefs: e.evidenceRefs.length > 0 ? e.evidenceRefs.slice(0, 12) : [`constituents:${e.constituentId}`],
    evidenceText: [...e.whyNow, ...e.reviewReasons].slice(0, 8),
  }));
  if (items.length === 0) {
    return {
      explanations: [],
      llm: { calls: 0, inputTokens: 0, outputTokens: 0, model: null, fallback: true, filtered: 0 },
    };
  }
  try {
    const out = await explainRanked(items, { fetchFn: opts.fetchFn, model: opts.model });
    return {
      explanations: out.explanations,
      llm: {
        calls: 1,
        inputTokens: out.telemetry?.inputTokens ?? 0,
        outputTokens: out.telemetry?.outputTokens ?? 0,
        model: out.telemetry?.model ?? resolveLlmEnv().model,
        fallback: false,
        filtered: out.filtered,
      },
    };
  } catch {
    // Safe fallback: evidence-bound template per item, caller order preserved.
    return {
      explanations: items.map((it) => ({
        id: it.id,
        reason: `Held for review — evidence: ${it.evidenceRefs.slice(0, 4).join(", ")}. Action: ${String(it.action ?? "").slice(0, 40)}.`.slice(0, 280),
      })),
      llm: { calls: 0, inputTokens: 0, outputTokens: 0, model: null, fallback: true, filtered: items.length },
    };
  }
}
