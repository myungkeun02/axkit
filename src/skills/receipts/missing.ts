import type { SpendEntry } from '../../core/contracts/index.js';
import type { DocEntry } from './types.js';

const WINDOW_MS = 3 * 86_400_000;
const MAX_LINES = 10;

function withinWindow(spendAt: number, docAt: number): boolean {
  return Number.isFinite(spendAt) && Number.isFinite(docAt) && Math.abs(spendAt - docAt) <= WINDOW_MS;
}

function sameAmount(doc: DocEntry, entry: SpendEntry): boolean {
  return doc.amount !== undefined && Number.isFinite(doc.amount) && doc.amount === entry.originalAmount;
}

function sameMerchant(doc: DocEntry, entry: SpendEntry): boolean {
  const left = entry.merchantKey.trim().toLowerCase();
  const right = (doc.merchantKey ?? '').trim().toLowerCase();
  if (left === '' || right === '') return false;
  return left === right || left.includes(right) || right.includes(left);
}

function hasReceiptDoc(entry: SpendEntry, docs: readonly DocEntry[]): boolean {
  const spendAt = Date.parse(entry.at);
  return docs.some(
    (doc) => withinWindow(spendAt, Date.parse(doc.at)) && (sameMerchant(doc, entry) || sameAmount(doc, entry)),
  );
}

/** Spend entries at or above the minimum with no matching document within ±3 days, newest last, at most 10. */
export function missingReceipts(
  spend: readonly SpendEntry[],
  docs: readonly DocEntry[],
  missingMin: number,
): SpendEntry[] {
  return spend
    .filter((entry) => entry.amount >= missingMin && entry.hasReceipt !== true)
    .filter((entry) => !hasReceiptDoc(entry, docs))
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(0, MAX_LINES);
}
