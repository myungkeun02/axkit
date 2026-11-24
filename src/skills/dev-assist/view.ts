import type { Job, JobPhase } from './types.js';
import { isActiveJob } from './types.js';

export interface JobView {
  id: string;
  repo: string;
  branch: string;
  title: string;
  status: Job['status'];
  tests: 'passed' | 'failed' | 'not_run';
  diffStat: string;
  createdAt: string;
  updatedAt?: string;
  /** The step a queued or running job is at. */
  phase?: JobPhase;
  /** Minutes since the job was asked for, while it is queued or running. */
  elapsedMinutes?: number;
  prUrl?: string;
  error?: string;
  issue?: number;
}

export function jobView(job: Job, now?: Date): JobView {
  const active = isActiveJob(job);
  const started = Date.parse(job.createdAt);
  const elapsed =
    active && now !== undefined && !Number.isNaN(started) ? Math.max(0, Math.floor((now.getTime() - started) / 60_000)) : undefined;
  return {
    id: job.id,
    repo: job.repo,
    branch: job.branch,
    title: job.title,
    status: job.status,
    tests: job.tests === undefined ? 'not_run' : job.tests.passed ? 'passed' : 'failed',
    diffStat: job.diffStat,
    createdAt: job.createdAt,
    ...(job.updatedAt !== undefined ? { updatedAt: job.updatedAt } : {}),
    ...(active && job.phase !== undefined ? { phase: job.phase } : {}),
    ...(elapsed !== undefined ? { elapsedMinutes: elapsed } : {}),
    ...(job.prUrl !== undefined ? { prUrl: job.prUrl } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.issue !== undefined ? { issue: job.issue } : {}),
  };
}
