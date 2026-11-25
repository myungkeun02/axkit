import { z } from 'zod';
import type { KeyValueStore } from '../../core/store/types.js';

export type RunStatus = 'idle' | 'running' | 'paused' | 'done' | 'failed';
export type ScanPhase = 'local' | 'projects' | 'drive' | 'signals' | 'profile' | 'done';
export type RunReason = 'first' | 'daily' | 'manual';

export interface RunCounts {
  files: number;
  repos: number;
  drive: number;
  summarized: number;
  signals: number;
  /** Documents read inside picked projects. */
  docs: number;
  /** Claude Code / Codex sessions read. */
  sessions: number;
}

const CountsSchema = z.object({
  files: z.number().int().nonnegative().default(0),
  repos: z.number().int().nonnegative().default(0),
  drive: z.number().int().nonnegative().default(0),
  summarized: z.number().int().nonnegative().default(0),
  signals: z.number().int().nonnegative().default(0),
  docs: z.number().int().nonnegative().default(0),
  sessions: z.number().int().nonnegative().default(0),
});

const StateSchema = z.object({
  status: z.enum(['idle', 'running', 'paused', 'done', 'failed']).default('idle'),
  phase: z.enum(['local', 'projects', 'drive', 'signals', 'profile', 'done']).default('local'),
  reason: z.enum(['first', 'daily', 'manual']).optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  firstDoneAt: z.string().optional(),
  reviewSentAt: z.string().optional(),
  /** Who wrote the saved profile; a code-only fallback never replaces one a model wrote. */
  profileBy: z.enum(['model', 'code']).optional(),
  /** Hash of everything the last profile was built from; an unchanged daily run skips the model. */
  fingerprint: z.string().optional(),
  counts: CountsSchema.default({ files: 0, repos: 0, drive: 0, summarized: 0, signals: 0, docs: 0, sessions: 0 }),
  /** Readable files the last run left unread (over its budget); a follow-up run reads them. */
  pending: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export type RunState = z.infer<typeof StateSchema>;

export function zeroCounts(): RunCounts {
  return { files: 0, repos: 0, drive: 0, summarized: 0, signals: 0, docs: 0, sessions: 0 };
}

function initial(): RunState {
  return { status: 'idle', phase: 'local', counts: zeroCounts() };
}

const STATE_KEY = 'run';

/** The scan's current state, kept in the plugin's key-value store so a restart resumes. */
export class RunStateStore {
  private state: RunState = initial();

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    const parsed = StateSchema.safeParse(await this.kv.get<unknown>(STATE_KEY));
    this.state = parsed.success ? parsed.data : initial();
  }

  get current(): RunState {
    return { ...this.state, counts: { ...this.state.counts } };
  }

  async begin(reason: RunReason, startedAt: string): Promise<void> {
    const { firstDoneAt, reviewSentAt, profileBy, fingerprint } = this.state;
    this.state = {
      status: 'running',
      phase: 'local',
      reason,
      startedAt,
      counts: zeroCounts(),
      ...(firstDoneAt !== undefined ? { firstDoneAt } : {}),
      ...(reviewSentAt !== undefined ? { reviewSentAt } : {}),
      ...(profileBy !== undefined ? { profileBy } : {}),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
    };
    await this.save();
  }

  async setPhase(phase: ScanPhase): Promise<void> {
    this.state.phase = phase;
    await this.save();
  }

  async setCounts(counts: RunCounts): Promise<void> {
    this.state.counts = counts;
    await this.save();
  }

  async setPending(pending: number): Promise<void> {
    if (pending > 0) this.state.pending = pending;
    else delete this.state.pending;
    await this.save();
  }

  async pause(): Promise<void> {
    this.state.status = 'paused';
    await this.save();
  }

  async fail(error: string, finishedAt: string): Promise<void> {
    this.state.status = 'failed';
    this.state.error = error;
    this.state.finishedAt = finishedAt;
    await this.save();
  }

  async finish(finishedAt: string, counts: RunCounts, first: boolean): Promise<void> {
    this.state.status = 'done';
    this.state.phase = 'done';
    this.state.finishedAt = finishedAt;
    this.state.counts = counts;
    if (first && this.state.firstDoneAt === undefined) this.state.firstDoneAt = finishedAt;
    await this.save();
  }

  async markProfile(by: 'model' | 'code', fingerprint: string): Promise<void> {
    this.state.profileBy = by;
    this.state.fingerprint = fingerprint;
    await this.save();
  }

  async markReviewSent(at: string): Promise<void> {
    this.state.reviewSentAt = at;
    await this.save();
  }

  async save(): Promise<void> {
    await this.kv.set(STATE_KEY, this.state);
  }
}
