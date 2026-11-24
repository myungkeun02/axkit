import type { MoneyCurrency } from './types.js';
import { extractKrw } from './price-ko.js';
import { extractUsd } from './price-en.js';

/** Reads a page price in the home currency; the other currency is a fallback for pages that only show it. */
export function extractPrice(text: string, currency: MoneyCurrency): number | undefined {
  if (currency === 'KRW') return extractKrw(text) ?? extractUsd(text);
  return extractUsd(text) ?? extractKrw(text);
}
