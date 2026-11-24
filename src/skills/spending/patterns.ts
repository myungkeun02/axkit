import type { SpendCategory, SpendEntry } from '../../core/contracts/index.js';
import { minutesOfDay, weekdayOf, ymdOf } from '../../core/time/local-day.js';
import { roundMoney } from './fx.js';

export type TimeBand = 'morning' | 'lunch' | 'afternoon' | 'evening' | 'night';

export const TIME_BANDS: readonly TimeBand[] = ['morning', 'lunch', 'afternoon', 'evening', 'night'];

const CARD_SOURCES: ReadonlySet<string> = new Set(['sms', 'app', 'chat']);
const WEEKEND_DAYS: ReadonlySet<number> = new Set([0, 6]);
const NOTABLE_SHARE_PERCENT = 5;
const NOTABLE_CHANGE_RATIO = 2;
const TOP_MERCHANTS = 5;

export interface CategoryPattern {
  category: SpendCategory;
  total: number;
  count: number;
  /** Percent of the month total. */
  share: number;
}

export interface CategoryChange {
  category: SpendCategory;
  current: number;
  previous: number;
  change: number;
  changePercent: number | null;
  direction: 'up' | 'down' | 'new';
}

export interface MerchantPattern {
  merchant: string;
  merchantKey: string;
  total: number;
  count: number;
}

export interface BandPattern {
  band: TimeBand;
  total: number;
  count: number;
  /** Percent of the month total. */
  share: number;
}

export interface UnusualEntry {
  entry: SpendEntry;
  /** Median of the category's positive charges over the lookback months. */
  median: number;
}

export interface DuplicateCandidate {
  merchant: string;
  merchantKey: string;
  amount: number;
  ymd: string;
  entries: readonly SpendEntry[];
}

export interface MonthPatterns {
  month: string;
  currency: string;
  total: number;
  count: number;
  previousTotal: number;
  totalChangePercent: number | null;
  byCategory: readonly CategoryPattern[];
  changes: readonly CategoryChange[];
  topMerchants: readonly MerchantPattern[];
  weekday: { total: number; share: number };
  weekend: { total: number; share: number };
  bands: readonly BandPattern[];
  unusual: readonly UnusualEntry[];
  duplicates: readonly DuplicateCandidate[];
  fxEstimatedCount: number;
}

export interface PatternInput {
  month: string;
  entries: readonly SpendEntry[];
  previous: readonly SpendEntry[];
  /** The three months before `month`, used for the category median. */
  history: readonly SpendEntry[];
  timeZone: string;
  currency: string;
  largeAmount: number;
}

function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / Math.abs(whole)) * 1000) / 10;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function timeBandOf(at: Date, timeZone: string): TimeBand {
  const minutes = minutesOfDay(at, timeZone);
  if (minutes < 11 * 60) return 'morning';
  if (minutes < 14 * 60) return 'lunch';
  if (minutes < 18 * 60) return 'afternoon';
  if (minutes < 22 * 60) return 'evening';
  return 'night';
}

function active(entries: readonly SpendEntry[]): SpendEntry[] {
  return entries.filter((entry) => entry.excluded !== true);
}

interface Sum {
  total: number;
  count: number;
}

function categorySums(entries: readonly SpendEntry[]): Map<SpendCategory, Sum> {
  const sums = new Map<SpendCategory, Sum>();
  for (const entry of entries) {
    const found = sums.get(entry.category) ?? { total: 0, count: 0 };
    found.total += entry.amount;
    found.count += 1;
    sums.set(entry.category, found);
  }
  return sums;
}

function categoryChanges(
  current: Map<SpendCategory, Sum>,
  previous: Map<SpendCategory, Sum>,
  monthTotal: number,
  previousTotal: number,
  currency: string,
): CategoryChange[] {
  const categories = new Set<SpendCategory>([...current.keys(), ...previous.keys()]);
  const changes: CategoryChange[] = [];
  for (const category of categories) {
    const currentTotal = current.get(category)?.total ?? 0;
    const previousCategoryTotal = previous.get(category)?.total ?? 0;
    const change = currentTotal - previousCategoryTotal;
    if (change === 0) continue;
    const share = Math.max(
      percent(currentTotal, monthTotal),
      percent(previousCategoryTotal, previousTotal),
    );
    const ratio =
      previousCategoryTotal === 0
        ? Number.POSITIVE_INFINITY
        : Math.abs(change) / Math.abs(previousCategoryTotal);
    if (share < NOTABLE_SHARE_PERCENT && ratio < NOTABLE_CHANGE_RATIO) continue;
    const direction = previousCategoryTotal === 0 ? 'new' : change > 0 ? 'up' : 'down';
    changes.push({
      category,
      current: roundMoney(currency, currentTotal),
      previous: roundMoney(currency, previousCategoryTotal),
      change: roundMoney(currency, change),
      changePercent:
        previousCategoryTotal === 0
          ? null
          : Math.round((change / Math.abs(previousCategoryTotal)) * 1000) / 10,
      direction,
    });
  }
  return changes.sort((left, right) => Math.abs(right.change) - Math.abs(left.change));
}

function topMerchants(entries: readonly SpendEntry[], currency: string): MerchantPattern[] {
  const sums = new Map<string, Sum & { merchant: string }>();
  for (const entry of entries) {
    const found = sums.get(entry.merchantKey) ?? { total: 0, count: 0, merchant: entry.merchant };
    found.total += entry.amount;
    found.count += 1;
    found.merchant = entry.merchant;
    sums.set(entry.merchantKey, found);
  }
  return [...sums.entries()]
    .map(([merchantKey, value]) => ({
      merchant: value.merchant,
      merchantKey,
      total: roundMoney(currency, value.total),
      count: value.count,
    }))
    .sort((left, right) => right.total - left.total)
    .slice(0, TOP_MERCHANTS);
}

function bandsOf(entries: readonly SpendEntry[], timeZone: string, monthTotal: number, currency: string): BandPattern[] {
  const sums = new Map<TimeBand, Sum>();
  for (const entry of entries) {
    const band = timeBandOf(new Date(entry.at), timeZone);
    const found = sums.get(band) ?? { total: 0, count: 0 };
    found.total += entry.amount;
    found.count += 1;
    sums.set(band, found);
  }
  return TIME_BANDS.map((band) => {
    const found = sums.get(band) ?? { total: 0, count: 0 };
    return { band, total: roundMoney(currency, found.total), count: found.count, share: percent(found.total, monthTotal) };
  });
}

function unusualEntries(
  entries: readonly SpendEntry[],
  history: readonly SpendEntry[],
  largeAmount: number,
  currency: string,
): UnusualEntry[] {
  const amounts = new Map<SpendCategory, number[]>();
  for (const entry of history) {
    if (entry.amount <= 0) continue;
    const list = amounts.get(entry.category) ?? [];
    list.push(entry.amount);
    amounts.set(entry.category, list);
  }
  const found: UnusualEntry[] = [];
  for (const entry of entries) {
    if (entry.amount <= 0 || entry.amount < largeAmount) continue;
    const categoryMedian = median(amounts.get(entry.category) ?? []);
    if (categoryMedian === undefined || categoryMedian <= 0) continue;
    if (entry.amount < categoryMedian * 3) continue;
    found.push({ entry, median: roundMoney(currency, categoryMedian) });
  }
  return found.sort((left, right) => right.entry.amount - left.entry.amount);
}

function duplicatesOf(entries: readonly SpendEntry[], timeZone: string, currency: string): DuplicateCandidate[] {
  const groups = new Map<string, SpendEntry[]>();
  for (const entry of entries) {
    if (!CARD_SOURCES.has(entry.source)) continue;
    const day = ymdOf(new Date(entry.at), timeZone);
    const key = `${entry.merchantKey}|${entry.amount}|${day}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const duplicates: DuplicateCandidate[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const first = list[0];
    if (first === undefined) continue;
    duplicates.push({
      merchant: first.merchant,
      merchantKey: first.merchantKey,
      amount: roundMoney(currency, first.amount),
      ymd: ymdOf(new Date(first.at), timeZone),
      entries: list,
    });
  }
  return duplicates.sort((left, right) => left.ymd.localeCompare(right.ymd));
}

/** Totals, shares and anomalies for one month. Cancellations are negative entries and net out in totals. */
export function monthPatterns(input: PatternInput): MonthPatterns {
  const entries = active(input.entries);
  const previous = active(input.previous);
  const history = active(input.history);
  const currency = input.currency.toUpperCase();

  let total = 0;
  let previousTotal = 0;
  let weekdayTotal = 0;
  let weekendTotal = 0;
  let fxEstimatedCount = 0;
  for (const entry of entries) {
    total += entry.amount;
    if (WEEKEND_DAYS.has(weekdayOf(new Date(entry.at), input.timeZone))) weekendTotal += entry.amount;
    else weekdayTotal += entry.amount;
    if (entry.fxEstimated === true) fxEstimatedCount += 1;
  }
  for (const entry of previous) previousTotal += entry.amount;

  const categories = categorySums(entries);
  const byCategory: CategoryPattern[] = [...categories.entries()]
    .map(([category, value]) => ({
      category,
      total: roundMoney(currency, value.total),
      count: value.count,
      share: percent(value.total, total),
    }))
    .sort((left, right) => right.total - left.total);

  return {
    month: input.month,
    currency,
    total: roundMoney(currency, total),
    count: entries.length,
    previousTotal: roundMoney(currency, previousTotal),
    totalChangePercent:
      previousTotal === 0 ? null : Math.round(((total - previousTotal) / Math.abs(previousTotal)) * 1000) / 10,
    byCategory,
    changes: categoryChanges(categories, categorySums(previous), total, previousTotal, currency),
    topMerchants: topMerchants(entries, currency),
    weekday: { total: roundMoney(currency, weekdayTotal), share: percent(weekdayTotal, total) },
    weekend: { total: roundMoney(currency, weekendTotal), share: percent(weekendTotal, total) },
    bands: bandsOf(entries, input.timeZone, total, currency),
    unusual: unusualEntries(entries, history, input.largeAmount, currency),
    duplicates: duplicatesOf(entries, input.timeZone, currency),
    fxEstimatedCount,
  };
}
