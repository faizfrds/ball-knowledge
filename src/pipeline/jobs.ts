import type Database from "better-sqlite3";
import { runGiveCampusQuery, type QueryResult, type RunQueryOptions } from "./run-query.js";

export type QueryJobStatus = "queued" | "running" | "complete" | "error" | "cancelled";

export interface QueryJob {
  id: string;
  query: string;
  status: QueryJobStatus;
  stage: "queued" | "route" | "complete" | "error" | "cancelled";
  progress: number;
  createdAt: string;
  updatedAt: string;
  request: { asOf?: string; candidateCap?: number };
  result?: QueryResult;
  error?: string;
}

let sequence = 0;
const jobs = new Map<string, QueryJob>();

export function createQueryJob(input: { query: string; asOf?: string; candidateCap?: number }): QueryJob {
  const query = String(input.query ?? "").trim();
  if (!query) throw new Error("query is required");
  if (input.candidateCap !== undefined && (!Number.isInteger(input.candidateCap) || input.candidateCap < 1 || input.candidateCap > 20_000)) {
    throw new Error("candidateCap must be an integer in 1..20000");
  }
  const now = new Date().toISOString();
  const job: QueryJob = {
    id: `query-${Date.now().toString(36)}-${(++sequence).toString(36)}`,
    query,
    status: "queued",
    stage: "queued",
    progress: 0,
    createdAt: now,
    updatedAt: now,
    request: { asOf: input.asOf, candidateCap: input.candidateCap },
  };
  jobs.set(job.id, job);
  return job;
}

export function getQueryJob(id: string): QueryJob | undefined {
  return jobs.get(id);
}

export function listQueryJobs(): QueryJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
}

export function cancelQueryJob(id: string): QueryJob | undefined {
  const job = jobs.get(id);
  if (!job || job.status === "complete" || job.status === "error") return job;
  job.status = "cancelled";
  job.stage = "cancelled";
  job.progress = 1;
  job.updatedAt = new Date().toISOString();
  return job;
}

export function clearQueryJobs(): void {
  jobs.clear();
  sequence = 0;
}

export async function runQueryJob(
  db: Database.Database,
  id: string,
  options: RunQueryOptions = {},
): Promise<QueryJob> {
  const job = jobs.get(id);
  if (!job) throw new Error(`query job not found: ${id}`);
  if (job.status !== "queued") return job;
  job.status = "running";
  job.stage = "route";
  job.progress = 0.05;
  job.updatedAt = new Date().toISOString();
  try {
    const result = await runGiveCampusQuery(db, job.query, {
      ...options,
      asOf: job.request.asOf ?? options.asOf,
      candidateCap: job.request.candidateCap ?? options.candidateCap,
    });
    if (jobs.get(id)?.status === "cancelled") return job;
    job.result = result;
    job.status = "complete";
    job.stage = "complete";
    job.progress = 1;
  } catch (error) {
    if (jobs.get(id)?.status !== "cancelled") {
      job.status = "error";
      job.stage = "error";
      job.error = (error as Error).message;
      job.progress = 1;
    }
  }
  job.updatedAt = new Date().toISOString();
  return job;
}
