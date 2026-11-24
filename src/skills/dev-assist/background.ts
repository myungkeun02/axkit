import type { WorkItem, WorkStatus } from '../../core/contracts/index.js';
import type { ConversationRef } from '../../core/conversation/types.js';
import { Lane } from '../work/lane.js';
import { mirrorWork, notifyOwner } from '../work/report.js';
import { coderGate } from './coder-budget.js';
import type { RepoConfig } from './config.js';
import { findRepo, unknownRepoError } from './config.js';
import type { DevToolDeps } from './deps.js';
import type { FinishedTask, StartTaskInput } from './run-task.js';
import { newJob, performJob } from './run-task.js';
import type { Job, JobOrigin } from './types.js';
import { isActiveJob } from './types.js';

export interface DevStartOutput {
  status: 'started' | 'queued';
  jobId: string;
  branch: string;
  /** Jobs ahead of this one. */
  ahead: number;
  message: string;
}

export interface DevRunnerOptions {
  /** Hard limit for one job: the coder, the slowest test run and a few minutes for git. */
  timeoutMs: number;
  /** Called with each finished job's result (tests). */
  onFinished?: (result: FinishedTask) => void;
}

/** Running plus queued; past this a new job is refused instead of pushing records out of the store. */
const MAX_UNFINISHED_JOBS = 20;

class Stopping extends Error {}
class TimedOut extends Error {}

/** Settles with the job, or rejects with the abort reason the moment `signal` aborts (a coder that ignores it). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function originOf(conversation: ConversationRef | undefined): JobOrigin | undefined {
  return conversation === undefined ? undefined : { channelId: conversation.channelId, address: conversation.address };
}

const WORK_STATUS: Record<Job['status'], WorkStatus> = {
  queued: 'queued',
  running: 'running',
  ready: 'done',
  pr_opened: 'done',
  failed: 'failed',
  interrupted: 'interrupted',
};

export function devWorkItem(deps: DevToolDeps, job: Job): WorkItem {
  const link = job.prUrl ?? (job.status === 'ready' ? job.branch : undefined);
  const summary = job.status === 'failed' ? job.error : job.status === 'ready' || job.status === 'pr_opened' ? job.diffStat : undefined;
  return {
    id: `dev:${job.id}`,
    kind: 'dev',
    title: `${job.repo}: ${job.title}`,
    status: WORK_STATUS[job.status],
    startedAt: job.createdAt,
    updatedAt: job.updatedAt ?? job.createdAt,
    ...(job.phase !== undefined && isActiveJob(job) ? { phase: deps.texts.phase(job.phase) } : {}),
    ...(job.origin !== undefined ? { origin: job.origin } : {}),
    ...(summary !== undefined && summary !== '' ? { summary: summary.slice(0, 600) } : {}),
    ...(link !== undefined ? { link } : {}),
  };
}

/**
 * Dev jobs off the conversation turn: the job is saved before git is touched, the owner hears "시작했어요" right away,
 * jobs run one at a time, and the result comes through the notifier.
 */
export class DevRunner {
  private readonly lane = new Lane();
  private readonly controllers = new Map<string, AbortController>();
  private stopping = false;

  constructor(
    private readonly deps: DevToolDeps,
    private readonly options: DevRunnerOptions,
  ) {
    deps.store.onChange((job) => mirrorWork(deps.ctx, devWorkItem(deps, job)));
    deps.ctx.bus.on('app.started', () => this.tellInterrupted());
    deps.ctx.bus.on('app.stopping', () => {
      this.stopping = true;
      for (const controller of this.controllers.values()) controller.abort();
    });
  }

  idle(): Promise<void> {
    return this.lane.idle();
  }

  async start(input: StartTaskInput, conversation: ConversationRef | undefined): Promise<DevStartOutput> {
    const repo = this.repoOf(input.repo);
    // a coding run is a subscription CLI for many minutes: not while stopped, over budget or past the day's runs
    const blocked = await coderGate(this.deps.ctx);
    if (blocked !== undefined) throw new Error(blocked);
    const unfinished = this.deps.store.all().filter(isActiveJob).length;
    if (unfinished >= MAX_UNFINISHED_JOBS) throw new Error(this.deps.texts.queueFull(unfinished));
    const current = this.deps.store.all().find((job) => job.status === 'running');
    const job = newJob(this.deps, input, originOf(conversation));
    await this.deps.store.add(job);
    return this.enqueue(job, repo, false, current?.title);
  }

  /** Reruns an interrupted job on its own worktree, or its branch when the worktree is gone. */
  async resume(job: Job): Promise<DevStartOutput> {
    const repo = this.repoOf(job.repo);
    const current = this.deps.store.all().find((candidate) => candidate.status === 'running');
    const queued: Job = { ...job, status: 'queued', told: true, updatedAt: this.now() };
    await this.deps.store.update(queued);
    return this.enqueue(queued, repo, true, current?.title);
  }

  private enqueue(job: Job, repo: RepoConfig, resume: boolean, current: string | undefined): DevStartOutput {
    const ahead = this.lane.enqueue(() => this.execute(job.id, repo, resume));
    const message = ahead > 0 ? this.deps.texts.queued(job.id, ahead, current) : this.deps.texts.started(job.id);
    return { status: ahead > 0 ? 'queued' : 'started', jobId: job.id, branch: job.branch, ahead, message };
  }

  private async execute(id: string, repo: RepoConfig, resume: boolean): Promise<void> {
    const stored = this.deps.store.get(id);
    // discarded while it waited, or the server is going down
    if (stored === undefined || stored.status !== 'queued' || this.stopping) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const signal = controller.signal;
    const timer = this.deps.ctx.clock.setTimeout(() => controller.abort(new TimedOut('timed out')), this.options.timeoutMs);
    let finished: { job: Job; result: FinishedTask };
    try {
      const work = performJob(this.deps, repo, stored, { checkpoint: (job) => this.checkpoint(job, signal), signal, resume });
      finished = await untilAborted(work, signal);
    } catch (error) {
      // a shutdown leaves the job "running" in the store; the next start marks it interrupted and tells the owner
      if (error instanceof Stopping || this.stopping) return;
      const current = this.deps.store.get(id) ?? stored;
      const timedOut = error instanceof TimedOut;
      const message = timedOut ? this.deps.texts.timedOut(current.phase) : error instanceof Error ? error.message : String(error);
      const failedJob: Job = { ...current, status: 'failed', error: message.slice(0, 1000) };
      await this.deps.store.update({ ...failedJob, updatedAt: this.now() });
      const text = timedOut ? message : this.deps.texts.startFailed(message);
      finished = { job: failedJob, result: { status: 'failed', jobId: id, branch: failedJob.branch, error: message, message: text } };
    } finally {
      this.deps.ctx.clock.clearTimeout(timer);
      this.controllers.delete(id);
    }
    await notifyOwner(this.deps.ctx, {
      kind: 'dev.job',
      text: this.deps.texts.finished(finished.job.title, finished.result.message, id),
      dedupeKey: `${id}:${finished.result.status}`,
    });
    this.options.onFinished?.(finished.result);
  }

  /** Saves a step; past the deadline or during shutdown it throws, so a late coder can never save or commit. */
  private async checkpoint(job: Job, signal: AbortSignal): Promise<Job> {
    if (this.stopping) throw new Stopping('stopping');
    signal.throwIfAborted();
    const saved: Job = { ...job, updatedAt: this.now() };
    await this.deps.store.update(saved);
    return saved;
  }

  private async tellInterrupted(): Promise<void> {
    for (const job of this.deps.store.all().filter((candidate) => candidate.status === 'interrupted' && candidate.told === false)) {
      await notifyOwner(this.deps.ctx, {
        kind: 'work.interrupted',
        text: this.deps.texts.interrupted(job.title, job.id),
        dedupeKey: `dev:${job.id}`,
      });
      await this.deps.store.update({ ...job, told: true });
    }
  }

  private repoOf(slug: string): RepoConfig {
    const repo = findRepo(this.deps.config, slug);
    if (repo === undefined) throw unknownRepoError(this.deps.config, slug);
    return repo;
  }

  private now(): string {
    return this.deps.ctx.clock.now().toISOString();
  }
}
