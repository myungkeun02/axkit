import type { SpendEntry } from '../../core/contracts/index.js';
import { ymdOf } from '../../core/time/local-day.js';
import type { ReceiptInfo } from './ocr-parse.js';

const MAX_MATCHES = 3;
const WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;
const COMPANY_SUFFIX = /주식회사|유한회사|\(주\)|㈜|\b(?:inc|ltd|llc|corp|co)\b\.?/gi;

interface Scored {
  entry: SpendEntry;
  shared: number;
  distance: number;
}

function tokensOf(name: string | undefined): Set<string> {
  if (name === undefined || name.trim() === '') return new Set();
  const tokens = name
    .toLowerCase()
    .replace(COMPANY_SUFFIX, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
  return new Set(tokens);
}

function sharedTokens(receiptMerchant: string | undefined, entryMerchant: string): number {
  const left = tokensOf(receiptMerchant);
  const right = tokensOf(entryMerchant);
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

function amountMatches(receipt: ReceiptInfo, entry: SpendEntry): boolean {
  if (receipt.amount === undefined) return false;
  const sameCurrency =
    receipt.currency !== undefined && receipt.currency.toUpperCase() === entry.currency.toUpperCase();
  const target = sameCurrency ? entry.originalAmount : entry.amount;
  const currency = sameCurrency ? entry.currency : (receipt.currency ?? entry.currency);
  const tolerance = currency.toUpperCase() === 'KRW' ? 1 : 0.01;
  return Math.abs(receipt.amount - target) < tolerance;
}

function receiptDay(receipt: ReceiptInfo): number | undefined {
  if (receipt.date === undefined) return undefined;
  const parsed = Date.parse(`${receipt.date}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function entryDay(entry: SpendEntry, timeZone: string): number | undefined {
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return undefined;
  return Date.parse(`${ymdOf(new Date(at), timeZone)}T00:00:00Z`);
}

/**
 * Ledger entries that could be this receipt: same amount (home amount, or the charged amount when the currencies
 * match) and, when the receipt has a date, within ±3 days. Closest merchant name first.
 */
export function matchSpend(
  receipt: ReceiptInfo,
  entries: readonly SpendEntry[],
  timeZone: string,
): SpendEntry[] {
  if (receipt.amount === undefined) return [];
  const day = receiptDay(receipt);

  const scored: Scored[] = [];
  for (const entry of entries) {
    if (!amountMatches(receipt, entry)) continue;
    const entryDate = entryDay(entry, timeZone);
    const distance = day !== undefined && entryDate !== undefined ? Math.abs(day - entryDate) / DAY_MS : 0;
    if (day !== undefined && (entryDate === undefined || distance > WINDOW_DAYS)) continue;
    scored.push({ entry, shared: sharedTokens(receipt.merchant, entry.merchant), distance });
  }

  scored.sort((left, right) => right.shared - left.shared || left.distance - right.distance);
  return scored.slice(0, MAX_MATCHES).map((item) => item.entry);
}
