import { wallClock } from '../../core/scheduler/next-run.js';
import { zonedIso } from '../../core/time/date-spec.js';
import { daysFromTo, ymdOf } from '../../core/time/local-day.js';

export type Cadence = 'monthly' | 'yearly';

export const DAY_MS = 86_400_000;
const DUPLICATE_WINDOW_DAYS = 3;
const LOOKBACK_DAYS = 400;
export const LOOKBACK_MS = LOOKBACK_DAYS * DAY_MS;

export interface SubscriptionCharge {
  at: Date;
  merchant: string;
  merchantKey: string;
  /** Home-currency amount; only positive charges are considered. */
  amount: number;
  currency: string;
}

export interface DetectedSubscription {
  /** `<merchantKey>:<cadence>`, with `:2`, `:3` when one merchant has several plans. */
  key: string;
  merchant: string;
  merchantKey: string;
  cadence: Cadence;
  amount: number;
  prevAmount: number | null;
  currency: string;
  charges: number;
  firstAt: Date;
  lastAt: Date;
  /** Same day of month, clamped to the month end, in the owner zone. */
  nextAt: Date;
  lapsed: boolean;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds calendar months on the owner's wall clock, clamping 31 January to 28/29 February. */
export function addMonthsLocal(at: Date, months: number, timeZone: string): Date {
  const wall = wallClock(at, timeZone);
  const index = wall.y * 12 + (wall.m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const day = Math.min(wall.d, daysInMonth(year, month));
  const ymd = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  return new Date(zonedIso(ymd, `${pad2(wall.hh)}:${pad2(wall.mm)}`, timeZone));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** 15% either way, 30% for a price rise, or 1,000 home units — enough to keep one subscription as one plan. */
function similarAmount(base: number, amount: number): boolean {
  const fraction = amount > base ? 0.3 : 0.15;
  return Math.abs(amount - base) <= Math.max(base * fraction, 1000);
}

function gapsOf(cluster: readonly SubscriptionCharge[], timeZone: string): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < cluster.length; index += 1) {
    const previous = cluster[index - 1];
    const current = cluster[index];
    if (previous === undefined || current === undefined) continue;
    gaps.push(daysFromTo(ymdOf(previous.at, timeZone), ymdOf(current.at, timeZone)));
  }
  return gaps;
}

function cadenceOf(cluster: readonly SubscriptionCharge[], timeZone: string): Cadence | undefined {
  if (cluster.length < 2) return undefined;
  const gaps = gapsOf(cluster, timeZone);
  if (gaps.length === 0) return undefined;
  const middle = median(gaps);
  const missed = gaps.filter((gap) => gap >= 50 && gap <= 70).length;
  const monthly =
    gaps.every((gap) => (gap >= 20 && gap <= 40) || (gap >= 50 && gap <= 70)) &&
    missed <= 1 &&
    middle >= 25 &&
    middle <= 35;
  if (monthly) return 'monthly';
  const yearly =
    gaps.every((gap) => gap >= 350 && gap <= 395) && middle >= 350 && middle <= 380;
  return yearly ? 'yearly' : undefined;
}

function deduplicated(charges: readonly SubscriptionCharge[]): SubscriptionCharge[] {
  const kept: SubscriptionCharge[] = [];
  for (const charge of charges) {
    const previous = kept[kept.length - 1];
    if (
      previous !== undefined &&
      previous.amount === charge.amount &&
      charge.at.getTime() - previous.at.getTime() <= DUPLICATE_WINDOW_DAYS * DAY_MS
    ) {
      continue;
    }
    kept.push(charge);
  }
  return kept;
}

function clustersOf(charges: readonly SubscriptionCharge[]): SubscriptionCharge[][] {
  const clusters: SubscriptionCharge[][] = [];
  for (const charge of charges) {
    const cluster = clusters.find((candidate) => {
      const last = candidate[candidate.length - 1];
      return last !== undefined && similarAmount(last.amount, charge.amount);
    });
    if (cluster !== undefined) cluster.push(charge);
    else clusters.push([charge]);
  }
  return clusters;
}

function groupByCadence(
  charges: readonly SubscriptionCharge[],
  timeZone: string,
): Map<Cadence, SubscriptionCharge[][]> {
  const byCadence = new Map<Cadence, SubscriptionCharge[][]>();
  for (const cluster of clustersOf(deduplicated(charges))) {
    if (cluster.length < 2) continue;
    const cadence = cadenceOf(cluster, timeZone);
    if (cadence === undefined) continue;
    const list = byCadence.get(cadence) ?? [];
    list.push(cluster);
    byCadence.set(cadence, list);
  }
  return byCadence;
}

/** Detects recurring charges from the last ~400 days of the read-only ledger. Pure: no storage, no clock. */
export function detectSubscriptions(
  charges: readonly SubscriptionCharge[],
  now: Date,
  timeZone: string,
): DetectedSubscription[] {
  const groups = new Map<string, SubscriptionCharge[]>();
  for (const charge of charges) {
    if (!(charge.amount > 0) || !Number.isFinite(charge.amount) || charge.merchantKey === '') continue;
    const list = groups.get(charge.merchantKey) ?? [];
    list.push(charge);
    groups.set(charge.merchantKey, list);
  }

  const detected: DetectedSubscription[] = [];
  for (const [merchantKey, group] of groups) {
    const sorted = [...group].sort((left, right) => left.at.getTime() - right.at.getTime());
    for (const [cadence, clusters] of groupByCadence(sorted, timeZone)) {
      clusters.sort((left, right) => (left[left.length - 1]?.amount ?? 0) - (right[right.length - 1]?.amount ?? 0));
      clusters.forEach((cluster, index) => {
        const last = cluster[cluster.length - 1];
        if (last === undefined) return;
        const previous = cluster[cluster.length - 2];
        const nextAt = addMonthsLocal(last.at, cadence === 'monthly' ? 1 : 12, timeZone);
        const lateDays = cadence === 'monthly' ? 10 : 30;
        const base = `${merchantKey}:${cadence}`;
        detected.push({
          key: index === 0 ? base : `${base}:${index + 1}`,
          merchant: last.merchant,
          merchantKey,
          cadence,
          amount: last.amount,
          prevAmount: previous === undefined ? null : previous.amount,
          currency: last.currency,
          charges: cluster.length,
          firstAt: cluster[0]?.at ?? last.at,
          lastAt: last.at,
          nextAt,
          lapsed: now.getTime() > nextAt.getTime() + lateDays * DAY_MS,
        });
      });
    }
  }
  return detected.sort((left, right) => left.nextAt.getTime() - right.nextAt.getTime() || left.key.localeCompare(right.key));
}
