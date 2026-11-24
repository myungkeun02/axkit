import type { Clock, Job, JobRun, JobRunStore, JobStatus, Schedule, Scheduler } from './types.js';
import type { Logger } from '../log/types.js';
import { maskForModel } from '../text/mask.js';
import { systemClock } from './clock.js';
import { nextDailyRun } from './next-run.js';
import { backoffMs, isTransientNetworkError } from './backoff.js';
import type { NetStreak } from './backoff.js';
import { WALL_CHECK_MS, missedDailyDue, nextDueAfter } from './catch-up.js';

interface JobState {
  job: Job;
  nextDue: number;
  timer: unknown;
  running: boolean;
  stopped: boolean;
  lastRun?: JobRun;
  /** Set while the job keeps failing with transient network errors; ticks before `nextAt` are skipped. */
  net?: NetStreak;
}

const MAX_ERROR_CHARS = 200;

interface SchedulerOptions {
  timeZone: string;
  log: Logger;
  clock?: Clock;
  /** Where the last run of each job is kept; without it the app only sees runs since this start. */
  runs?: JobRunStore;
}

export class TimerScheduler implements Scheduler {
  private readonly clock: Clock;
  private readonly states = new Map<string, JobState>();
  private readonly pending = new Set<Promise<void>>();
  private started = false;
  private wallTimer: unknown;
  private paused: ((name: string) => Promise<boolean>) | undefined;

  constructor(private readonly opts: SchedulerOptions) {
    this.clock = opts.clock ?? systemClock;
  }

  setPauseCheck(paused: (name: string) => Promise<boolean>): void {
    this.paused = paused;
  }

  add(job: Job): void {
    if (this.states.has(job.name)) throw new Error(`Duplicate job name: ${job.name}`);
    this.validate(job.schedule);
    const nextDue = this.firstRun(job.schedule).getTime();
    const state: JobState = { job, nextDue, timer: undefined, running: false, stopped: !this.started };
    this.states.set(job.name, state);
    if (this.started) {
      this.arm(state);
      this.catchUp(state);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const state of this.states.values()) {
      state.stopped = false;
      state.nextDue = this.firstRun(state.job.schedule).getTime();
      this.arm(state);
      this.catchUp(state);
    }
    this.armWallCheck();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.wallTimer !== undefined) {
      this.clock.clearTimeout(this.wallTimer);
      this.wallTimer = undefined;
    }
    for (const state of this.states.values()) {
      state.stopped = true;
      if (state.timer !== undefined) {
        this.clock.clearTimeout(state.timer);
        state.timer = undefined;
      }
    }
    await Promise.allSettled([...this.pending]);
  }

  remove(name: string): boolean {
    const state = this.states.get(name);
    if (state === undefined) return false;
    state.stopped = true;
    if (state.timer !== undefined) {
      this.clock.clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.states.delete(name);
    return true;
  }

  nextRun(name: string): Date | undefined {
    const state = this.states.get(name);
    if (state === undefined) return undefined;
    return new Date(state.nextDue);
  }

  async list(): Promise<JobStatus[]> {
    const out: JobStatus[] = [];
    for (const state of this.states.values()) {
      if (state.lastRun === undefined) {
        const stored = await this.opts.runs?.read(state.job.name).catch(() => undefined);
        if (stored !== undefined) state.lastRun = stored;
      }
      out.push({
        name: state.job.name,
        ...(state.job.label !== undefined ? { label: state.job.label } : {}),
        schedule: state.job.schedule,
        running: state.running,
        ...(this.started ? { nextRunAt: new Date(state.nextDue) } : {}),
        ...(state.lastRun !== undefined ? { lastRun: state.lastRun } : {}),
      });
    }
    return out;
  }

  private record(state: JobState, run: JobRun): void {
    state.lastRun = run;
    // Bookkeeping never fails a job.
    void this.opts.runs?.write(state.job.name, run).catch(() => undefined);
  }

  private validate(schedule: Schedule): void {
    if (schedule.kind === 'every') {
      if (!Number.isFinite(schedule.seconds) || schedule.seconds < 1) {
        throw new RangeError('Interval jobs must run at least every 1 second');
      }
      return;
    }
    try {
      nextDailyRun(this.clock.now(), schedule.at, this.opts.timeZone);
    } catch (error) {
      if (error instanceof RangeError) throw error;
      throw new RangeError(`Invalid daily schedule: ${schedule.at}`);
    }
  }

  private firstRun(schedule: Schedule): Date {
    if (schedule.kind === 'every') {
      return new Date(this.clock.now().getTime() + schedule.seconds * 1000);
    }
    return nextDailyRun(this.clock.now(), schedule.at, this.opts.timeZone);
  }

  /**
   * Node timers follow a monotonic clock that stands still while a Mac sleeps, so a timer armed for 07:00 before the
   * lid closed can fire long after. Once a minute the plan is compared with the wall clock and overdue jobs run now.
   */
  private armWallCheck(): void {
    if (!this.started) return;
    this.wallTimer = this.clock.setTimeout(() => {
      this.wallTimer = undefined;
      const now = this.clock.now().getTime();
      for (const state of this.states.values()) {
        if (state.stopped || state.timer === undefined || state.nextDue > now) continue;
        this.clock.clearTimeout(state.timer);
        void this.tick(state);
      }
      this.armWallCheck();
    }, WALL_CHECK_MS);
  }

  /** A daily run whose time passed while the server was off (within the grace window) runs once at start. */
  private catchUp(state: JobState): void {
    const runs = this.opts.runs;
    if (runs === undefined || state.job.schedule.kind !== 'daily') return;
    const check = (async (): Promise<void> => {
      const last = await runs.read(state.job.name).catch(() => undefined);
      if (last !== undefined && state.lastRun === undefined) state.lastRun = last;
      const due = missedDailyDue(state.job.schedule, this.clock.now(), this.opts.timeZone, last);
      if (due === undefined || state.stopped || state.running) return;
      this.opts.log.info('running a daily job missed while the server was off', { job: state.job.name, due: due.toISOString() });
      await this.execute(state, due.getTime());
    })();
    this.pending.add(check);
    void check.then(() => this.pending.delete(check));
  }

  private arm(state: JobState): void {
    if (state.stopped) return;
    const delay = Math.max(0, state.nextDue - this.clock.now().getTime());
    state.timer = this.clock.setTimeout(() => {
      void this.tick(state);
    }, delay);
  }

  private async tick(state: JobState): Promise<void> {
    state.timer = undefined;
    if (state.stopped) return;
    const due = state.nextDue;
    state.nextDue = nextDueAfter(state.job.schedule, due, this.clock.now().getTime(), this.opts.timeZone);
    this.arm(state);
    if (state.running) {
      this.opts.log.warn('job still running; skipping this tick', { job: state.job.name });
      return;
    }
    await this.execute(state, due);
  }

  private async execute(state: JobState, due: number): Promise<void> {
    if (state.running) return;
    if (state.net !== undefined && this.clock.now().getTime() < state.net.nextAt) return;
    state.running = true;
    // a failing check runs the job: a broken switch store must not silently stop every job
    if (this.paused !== undefined && (await this.paused(state.job.name).catch(() => false))) {
      state.running = false;
      return;
    }
    const started = this.clock.now();
    this.record(state, { startedAt: started.toISOString() });
    const task = (async (): Promise<void> => {
      let error: string | undefined;
      try {
        await state.job.run(new Date(due));
        this.recovered(state);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        error = maskForModel(message).slice(0, MAX_ERROR_CHARS);
        if (isTransientNetworkError(caught)) this.backOff(state, error);
        else this.opts.log.error('scheduled job failed', { job: state.job.name, error: message });
      } finally {
        state.running = false;
        const ended = this.clock.now();
        this.record(state, {
          startedAt: started.toISOString(),
          endedAt: ended.toISOString(),
          durationMs: Math.max(0, ended.getTime() - started.getTime()),
          ok: error === undefined,
          ...(error !== undefined ? { error } : {}),
        });
      }
    })();
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }

  private intervalMs(schedule: Schedule): number {
    return schedule.kind === 'every' ? schedule.seconds * 1000 : 0;
  }

  private backOff(state: JobState, error: string): void {
    const now = this.clock.now().getTime();
    if (state.net === undefined) {
      state.net = { failures: 0, firstAt: now, nextAt: now, lastError: error };
      this.opts.log.warn('scheduled job is offline; backing off until the network recovers', { job: state.job.name, error });
    }
    state.net.failures += 1;
    state.net.lastError = error;
    state.net.nextAt = now + backoffMs(this.intervalMs(state.job.schedule), state.net.failures);
  }

  private recovered(state: JobState): void {
    const streak = state.net;
    if (streak === undefined) return;
    delete state.net;
    this.opts.log.info('scheduled job is back online', {
      job: state.job.name,
      failures: streak.failures,
      offlineMs: this.clock.now().getTime() - streak.firstAt,
      lastError: streak.lastError,
    });
  }
}
