export type Schedule =
  | { kind: 'every'; seconds: number }
  /** Wall-clock time in the assistant's time zone (config `assistant.timezone`). */
  | { kind: 'daily'; at: `${number}:${number}` };

export interface Job {
  /** Unique, e.g. "briefing.morning". */
  name: string;
  schedule: Schedule;
  /** Optional name a person reads ("Morning briefing"); the app shows `name` when it is missing. */
  label?: string;
  run(now: Date): Promise<void>;
}

/** The last run of one job. Errors are masked and cut before they are kept. */
export interface JobRun {
  /** ISO 8601. */
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
}

export interface JobStatus {
  name: string;
  label?: string;
  schedule: Schedule;
  running: boolean;
  nextRunAt?: Date;
  lastRun?: JobRun;
}

/** Keeps one last run per job, so the app can show it after a restart. */
export interface JobRunStore {
  read(name: string): Promise<JobRun | undefined>;
  write(name: string, run: JobRun): Promise<void>;
}

export interface Scheduler {
  add(job: Job): void;
  start(): void;
  stop(): Promise<void>;
  /** Next planned run of a job, for `doctor` and tests. */
  nextRun(name: string): Date | undefined;
  /** Takes a job off for good (a removed routine); false when there was none. A run in progress finishes. */
  remove?(name: string): boolean;
  /** Every registered job with its last run, for the app's jobs screen. */
  list?(): Promise<JobStatus[]>;
  /** Asked before each run; a job it answers true for is skipped (the owner turned it off, or the breaker did). */
  setPauseCheck?(paused: (name: string) => Promise<boolean>): void;
}

/** Time source and timers are injected so tests never wait for real time. */
export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
