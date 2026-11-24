import type { Logger } from '../../core/log/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { trimFinished } from '../work/retention.js';
import type { Job } from './types.js';
import { isActiveJob, jobSchema, MAX_JOBS } from './types.js';

const KEY = 'jobs';

/** Never pushed out by the cap: still running or queued, or cut off by a restart and not reported yet. */
function keepable(job: Job): boolean {
  return isActiveJob(job) || (job.status === 'interrupted' && job.told !== true);
}

/**
 * Bounded job store. Running and queued jobs are stored as they start, so after a crash or restart `load` finds them
 * and marks them interrupted (the owner is told once, and can resume on the same branch).
 */
export class JobStore {
  private items: Job[] = [];
  /** Called after a job is added or changed (the owner's work list mirrors it). */
  private listener: ((job: Job) => Promise<void>) | undefined;

  constructor(
    private readonly kv: KeyValueStore,
    private readonly log: Logger,
  ) {}

  async load(now?: string): Promise<void> {
    const raw = await this.kv.get<unknown>(KEY);
    if (!Array.isArray(raw)) {
      this.items = [];
      return;
    }
    const parsed: Job[] = [];
    for (const candidate of raw) {
      const result = jobSchema.safeParse(candidate);
      if (result.success) parsed.push(result.data);
      else this.log.warn('dev-assist: dropping an unreadable job');
    }
    this.items = parsed.map((job) =>
      isActiveJob(job) ? { ...job, status: 'interrupted' as const, told: false, ...(now !== undefined ? { updatedAt: now } : {}) } : job,
    );
    trimFinished(this.items, MAX_JOBS, keepable);
    if (this.items.length !== parsed.length || this.items.some((job, index) => job !== parsed[index])) await this.persist();
  }

  onChange(listener: (job: Job) => Promise<void>): void {
    this.listener = listener;
  }

  all(): readonly Job[] {
    return this.items;
  }

  get(id: string): Job | undefined {
    return this.items.find((job) => job.id === id);
  }

  async add(job: Job): Promise<void> {
    this.items.unshift(job);
    // only finished jobs make room; a queued or running one would lose its record mid-run
    trimFinished(this.items, MAX_JOBS, keepable);
    await this.persist();
    await this.listener?.(job);
  }

  async update(job: Job): Promise<void> {
    const index = this.items.findIndex((candidate) => candidate.id === job.id);
    if (index < 0) return;
    this.items[index] = job;
    await this.persist();
    await this.listener?.(job);
  }

  async remove(id: string): Promise<Job | undefined> {
    const index = this.items.findIndex((candidate) => candidate.id === id);
    if (index < 0) return undefined;
    const [removed] = this.items.splice(index, 1);
    await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    return this.kv.set(KEY, this.items);
  }
}
