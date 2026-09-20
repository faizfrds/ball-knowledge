import type Database from "better-sqlite3";
import { buildWorklist, type WorklistResult } from "./worklist.js";
import type { JevClient } from "./jev.js";

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
  result?: WorklistResult;
  error?: string;
}

let seq = 0;
const jobs = new Map<string, WorklistJob>();

function nextId(): string {
  seq += 1;
  return `wl-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function createJob(filter: unknown, criterion: unknown, enrichWithJev: boolean): WorklistJob {
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
  opts: { jevClient?: JevClient } = {},
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
        .then((result) => {
          job.status = "done";
          job.progress = 1;
          job.result = result;
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
