import type { KeyValueStore } from '../store/types.js';
import { daysFromTo, ymdOf, ymdPlus } from '../time/local-day.js';

const KEY = 'notify.budget';
const KEEP_DAYS = 14;

/**
 * Non-urgent notices delivered or held per owner-zone day.
 * The old assistant kept caps in memory, so every restart handed the owner a fresh allowance.
 */
export class DailyNoticeBudget {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly timeZone: string,
  ) {}

  async used(ymd: string): Promise<number> {
    const days = (await this.kv.get<Record<string, number>>(KEY)) ?? {};
    return days[ymd] ?? 0;
  }

  /** The count for the owner-zone day containing `at`. */
  async usedAt(at: Date): Promise<number> {
    return this.used(ymdOf(at, this.timeZone));
  }

  async add(ymd: string): Promise<void> {
    const stored = (await this.kv.get<Record<string, number>>(KEY)) ?? {};
    const oldest = ymdPlus(ymd, -(KEEP_DAYS - 1));
    const days: Record<string, number> = {};
    for (const [day, count] of Object.entries(stored)) {
      if (daysFromTo(oldest, day) >= 0) days[day] = count;
    }
    days[ymd] = (days[ymd] ?? 0) + 1;
    await this.kv.set(KEY, days);
  }
}
