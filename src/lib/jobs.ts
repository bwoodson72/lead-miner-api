import { type LeadRecord } from "./schemas.js";

export type JobStatus = "pending" | "running" | "complete" | "failed";

export type Job = {
  id: string;
  status: JobStatus;
  createdAt: number;
  completedAt: number | null;
  leads: LeadRecord[];
  keywords: string[];
  diagnostics: Record<string, unknown> | null;
  error: string | null;
  progress: {
    stage: string;
    detail: string;
  };
};

const jobs = new Map<string, Job>();

export function createJob(): Job {
  const id = crypto.randomUUID();
  const job: Job = {
    id,
    status: "pending",
    createdAt: Date.now(),
    completedAt: null,
    leads: [],
    keywords: [],
    diagnostics: null,
    error: null,
    progress: { stage: "queued", detail: "Waiting to start" },
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, updates: Partial<Job>): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, updates);
}

// Clean up old jobs older than 1 hour to prevent memory leaks
export function cleanOldJobs(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < oneHourAgo) {
      jobs.delete(id);
    }
  }
}
