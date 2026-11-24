import type { SpendEntry } from '../../core/contracts/index.js';
import { monthPlus, monthRange } from '../../core/time/local-day.js';
import type { LedgerStore } from './ledger.js';
import type { MonthPatterns } from './patterns.js';
import { monthPatterns } from './patterns.js';

export interface LoadedMonth {
  entries: SpendEntry[];
  patterns: MonthPatterns;
}

function active(entries: readonly SpendEntry[]): SpendEntry[] {
  return entries.filter((entry) => entry.excluded !== true);
}

/** Loads one month plus the comparison months and builds its patterns in the owner zone. */
export async function loadPatternMonth(
  ledger: LedgerStore,
  month: string,
  timeZone: string,
  currency: string,
  largeAmount: number,
): Promise<LoadedMonth> {
  const entries = active(await ledger.list(monthRange(month, timeZone)));
  const previous = active(await ledger.list(monthRange(monthPlus(month, -1), timeZone)));
  const history: SpendEntry[] = [];
  for (let back = 1; back <= 3; back += 1) {
    history.push(...active(await ledger.list(monthRange(monthPlus(month, -back), timeZone))));
  }
  return {
    entries,
    patterns: monthPatterns({
      month,
      entries,
      previous,
      history,
      timeZone,
      currency,
      largeAmount,
    }),
  };
}
