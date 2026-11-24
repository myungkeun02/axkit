/** Capability "onboarding.first-look": the first look's live progress, cheap to read on every poll. */

export type FirstLookStatus = 'idle' | 'running' | 'paused' | 'done' | 'failed';

export interface FirstLookPhase {
  /** "local" | "projects" | "drive" | "signals" | "profile". */
  id: string;
  label: string;
  done: number;
  total: number;
  state: 'waiting' | 'active' | 'done';
}

export interface FirstLookProgress {
  status: FirstLookStatus;
  /** The phase being read now ("done" when finished). */
  phase: string;
  phases: FirstLookPhase[];
  /** files, repos, docs, sessions, drive, signals, summarized. */
  counts: Record<string, number>;
  /** 0–100 over all phases, weighted by how long each usually takes; 100 only when done. */
  percent: number;
  startedAt: string | null;
  finishedAt?: string;
  error?: string;
}

export interface FirstLookReader {
  progress(): FirstLookProgress;
  /** Starts a first look now unless one is running. */
  start(): 'started' | 'running';
}
