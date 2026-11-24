import type { NoticeKindStats, NoticeStats } from '../contracts/notify.js';
import type { KeyValueStore } from '../store/types.js';
import { daysFromTo, ymdOf, ymdPlus } from '../time/local-day.js';

const STATS_KEY = 'notify.stats';
const OVER_KEY = 'notify.overbudget';
const KEEP_DAYS = 35;
const WEEK_DAYS = 7;

interface Counts {
  sent: number;
  held: number;
  digested: number;
  dropped: number;
}

type Outcome = keyof Counts;
type DayStats = Record<string, Counts>;

const EMPTY: Counts = { sent: 0, held: 0, digested: 0, dropped: 0 };

/** Per-kind notice outcomes kept in the store, so a restart does not hide how noisy a day was. */
export class KvNoticeStats implements NoticeStats {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly timeZone: string,
  ) {}

  async count(at: Date, kind: string, outcome: Outcome): Promise<void> {
    const ymd = ymdOf(at, this.timeZone);
    const stats = await this.read();
    const day = stats[ymd] ?? {};
    const counts: Counts = { ...(day[kind] ?? EMPTY) };
    counts[outcome] += 1;
    day[kind] = counts;
    stats[ymd] = day;
    await this.kv.set(STATS_KEY, pruneDays(stats, ymd));
  }

  async markOverBudget(at: Date): Promise<void> {
    const ymd = ymdOf(at, this.timeZone);
    const marked = await this.readOverBudget();
    if (marked.includes(ymd)) return;
    const oldest = ymdPlus(ymd, -(KEEP_DAYS - 1));
    const kept = [...marked, ymd].filter((day) => daysFromTo(oldest, day) >= 0);
    await this.kv.set(OVER_KEY, kept);
  }

  async week(now: Date): Promise<NoticeKindStats[]> {
    const stats = await this.read();
    const today = ymdOf(now, this.timeZone);
    const totals = new Map<string, Counts>();
    for (let offset = 0; offset < WEEK_DAYS; offset += 1) {
      const day = stats[ymdPlus(today, -offset)];
      if (day === undefined) continue;
      for (const [kind, counts] of Object.entries(day)) {
        const sum: Counts = { ...(totals.get(kind) ?? EMPTY) };
        sum.sent += counts.sent;
        sum.held += counts.held;
        sum.digested += counts.digested;
        sum.dropped += counts.dropped;
        totals.set(kind, sum);
      }
    }
    return [...totals.entries()]
      .map(([kind, counts]) => ({ kind, ...counts }))
      .sort((a, b) => total(b) - total(a) || a.kind.localeCompare(b.kind));
  }

  async overBudgetDays(now: Date, days: number): Promise<number> {
    if (days <= 0) return 0;
    const today = ymdOf(now, this.timeZone);
    const oldest = ymdPlus(today, -(days - 1));
    const marked = await this.readOverBudget();
    return marked.filter((day) => {
      const offset = daysFromTo(oldest, day);
      return offset >= 0 && offset < days;
    }).length;
  }

  private async read(): Promise<Record<string, DayStats>> {
    return (await this.kv.get<Record<string, DayStats>>(STATS_KEY)) ?? {};
  }

  private async readOverBudget(): Promise<string[]> {
    return (await this.kv.get<string[]>(OVER_KEY)) ?? [];
  }
}

function total(counts: Counts): number {
  return counts.sent + counts.held + counts.digested + counts.dropped;
}

function pruneDays(stats: Record<string, DayStats>, today: string): Record<string, DayStats> {
  const oldest = ymdPlus(today, -(KEEP_DAYS - 1));
  const kept: Record<string, DayStats> = {};
  for (const [day, dayStats] of Object.entries(stats)) {
    if (daysFromTo(oldest, day) >= 0) kept[day] = dayStats;
  }
  return kept;
}
