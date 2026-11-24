import { z } from 'zod';
import type { KeyValueStore } from '../../core/store/types.js';

const Stored = z.object({
  answered: z.record(z.string(), z.string()).default({}),
  skipped: z.record(z.string(), z.boolean()).default({}),
  lastAsked: z.string().optional(),
  skipStreak: z.number().int().min(0).default(0),
  dailyPaused: z.boolean().default(false),
  introduced: z.boolean().default(false),
});

type Stored = z.infer<typeof Stored>;

const STATE_KEY = 'progress';
const PAUSE_AFTER_SKIPS = 3;

function empty(): Stored {
  return { answered: {}, skipped: {}, skipStreak: 0, dailyPaused: false, introduced: false };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key));
}

/** Which interview questions were asked, answered or skipped, kept in the plugin's key-value store. */
export class ProgressStore {
  private data: Stored = empty();

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    const parsed = Stored.safeParse(await this.kv.get<unknown>(STATE_KEY));
    this.data = parsed.success ? parsed.data : empty();
  }

  get introduced(): boolean {
    return this.data.introduced;
  }

  get dailyPaused(): boolean {
    return this.data.dailyPaused;
  }

  get lastAsked(): string | undefined {
    return this.data.lastAsked;
  }

  answeredOption(questionId: string): string | undefined {
    return this.data.answered[questionId];
  }

  isSkipped(questionId: string): boolean {
    return this.data.skipped[questionId] === true;
  }

  isResolved(questionId: string): boolean {
    return this.answeredOption(questionId) !== undefined || this.isSkipped(questionId);
  }

  async answer(questionId: string, optionId: string): Promise<void> {
    this.data.answered[questionId] = optionId;
    this.data.skipped = withoutKey(this.data.skipped, questionId);
    this.data.skipStreak = 0;
    this.data.dailyPaused = false;
    await this.persist();
  }

  async skip(questionId: string): Promise<void> {
    this.data.skipped[questionId] = true;
    this.data.answered = withoutKey(this.data.answered, questionId);
    this.data.skipStreak += 1;
    if (this.data.skipStreak >= PAUSE_AFTER_SKIPS) this.data.dailyPaused = true;
    await this.persist();
  }

  async markAsked(questionId: string): Promise<void> {
    this.data.lastAsked = questionId;
    await this.persist();
  }

  async markIntroduced(): Promise<void> {
    this.data.introduced = true;
    await this.persist();
  }

  private persist(): Promise<void> {
    return this.kv.set(STATE_KEY, this.data);
  }
}
