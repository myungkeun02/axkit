import { z } from 'zod';

/** `queued`/`running` live in the store too, so a restart can tell the owner what was cut off (`interrupted`). */
export type JobStatus = 'queued' | 'running' | 'ready' | 'failed' | 'pr_opened' | 'interrupted';

/** Checkpoints of a running job, saved as they pass. */
export type JobPhase = 'preparing' | 'worktree' | 'coding' | 'testing' | 'committing' | 'pr';
export const JOB_PHASES = ['preparing', 'worktree', 'coding', 'testing', 'committing', 'pr'] as const;

export interface JobOrigin {
  channelId: string;
  address: string;
}

export interface JobTests {
  passed: boolean;
  /** Last part of the test output, with secrets masked. */
  tail: string;
}

export interface Job {
  id: string;
  repo: string;
  branch: string;
  dir: string;
  title: string;
  request: string;
  issue?: number | undefined;
  status: JobStatus;
  tests?: JobTests | undefined;
  diffStat: string;
  error?: string | undefined;
  prUrl?: string | undefined;
  createdAt: string;
  phase?: JobPhase | undefined;
  updatedAt?: string | undefined;
  /** The conversation the request came from. */
  origin?: JobOrigin | undefined;
  /** The owner heard about the interruption. */
  told?: boolean | undefined;
  /** The owner looked at it and kept it on its branch (no PR): it no longer waits for a decision. */
  kept?: boolean | undefined;
}

export const MAX_JOBS = 50;
export const MAX_REQUEST_CHARS = 500;
export const MAX_TEST_TAIL_CHARS = 3000;

const testsSchema = z.object({
  passed: z.boolean(),
  tail: z.string().max(MAX_TEST_TAIL_CHARS * 2),
});

export const jobSchema = z.object({
  id: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  dir: z.string().min(1),
  title: z.string().min(1),
  request: z.string().max(MAX_REQUEST_CHARS * 2),
  issue: z.number().int().positive().optional(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'pr_opened', 'interrupted']),
  tests: testsSchema.optional(),
  diffStat: z.string(),
  error: z.string().optional(),
  prUrl: z.string().optional(),
  createdAt: z.string(),
  phase: z.enum(JOB_PHASES).optional(),
  updatedAt: z.string().optional(),
  origin: z.object({ channelId: z.string(), address: z.string() }).optional(),
  told: z.boolean().optional(),
  kept: z.boolean().optional(),
});

export function isActiveJob(job: Job): boolean {
  return job.status === 'queued' || job.status === 'running';
}
