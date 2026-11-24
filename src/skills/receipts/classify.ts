import type { DocKind } from './types.js';
import { EN_DOC_RULES, EN_MARKETING, EN_TOTAL } from './words-en.js';
import { KO_DOC_RULES, KO_MARKETING, KO_TOTAL } from './words-ko.js';

const DOC_RULES = [...KO_DOC_RULES, ...EN_DOC_RULES];
const MARKETING = [KO_MARKETING, EN_MARKETING];
const TOTAL_HINTS = [KO_TOTAL, EN_TOTAL];

const CODES = 'USD|EUR|JPY|GBP|CNY|KRW|AUD|CAD|CHF|HKD|SGD|THB|VND';
const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
const BODY_CHARS = 2_000;

export interface ClassifyInput {
  subject: string;
  from: string;
  body: string;
}

export interface DocumentClass {
  kind: DocKind;
  amount?: number;
  currency?: string;
  merchant?: string;
  merchantKey?: string;
}

interface Money {
  amount: number;
  currency: string;
}

function toNumber(raw: string): number | undefined {
  const value = Number(raw.replaceAll(',', ''));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** First amount and currency in a piece of text, preferring a symbol or code over a bare number. */
export function moneyOf(text: string): Money | undefined {
  const afterCode = new RegExp(`(${NUMBER})\\s*(${CODES})\\b`, 'i');
  const beforeCode = new RegExp(`\\b(${CODES})\\s*(${NUMBER})`, 'i');
  const patterns: { pattern: RegExp; amountGroup: number; currency: (match: RegExpExecArray) => string }[] = [
    { pattern: new RegExp(`(${NUMBER})\\s*원`), amountGroup: 1, currency: () => 'KRW' },
    { pattern: new RegExp(`[₩￦]\\s*(${NUMBER})`), amountGroup: 1, currency: () => 'KRW' },
    { pattern: new RegExp(`US\\$\\s*(${NUMBER})`, 'i'), amountGroup: 1, currency: () => 'USD' },
    { pattern: new RegExp(`\\$\\s*(${NUMBER})`), amountGroup: 1, currency: () => 'USD' },
    { pattern: new RegExp(`€\\s*(${NUMBER})`), amountGroup: 1, currency: () => 'EUR' },
    { pattern: new RegExp(`£\\s*(${NUMBER})`), amountGroup: 1, currency: () => 'GBP' },
    { pattern: new RegExp(`¥\\s*(${NUMBER})`), amountGroup: 1, currency: () => 'JPY' },
    { pattern: afterCode, amountGroup: 1, currency: (match) => (match[2] ?? '').toUpperCase() },
    { pattern: beforeCode, amountGroup: 2, currency: (match) => (match[1] ?? '').toUpperCase() },
  ];

  for (const entry of patterns) {
    const match = entry.pattern.exec(text);
    if (match === null) continue;
    const amount = toNumber(match[entry.amountGroup] ?? '');
    if (amount !== undefined) return { amount, currency: entry.currency(match) };
  }
  return undefined;
}

/** Amount on a total/합계 line wins; otherwise the first amount anywhere. */
export function preferredMoney(text: string): Money | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!TOTAL_HINTS.some((hint) => hint.test(line))) continue;
    const money = moneyOf(line);
    if (money !== undefined) return money;
  }
  return moneyOf(text);
}

export function kindOf(text: string): DocKind | undefined {
  return DOC_RULES.find((rule) => rule.pattern.test(text))?.kind;
}

/** Display name from a From header, with quotes removed. An address-only sender has no merchant name. */
export function cleanMerchant(from: string): string | undefined {
  const trimmed = from.trim();
  const address = /^(.*?)\s*<[^>]*>\s*$/.exec(trimmed);
  const display = address?.[1]?.trim();
  if (display === undefined || display === '' || display.includes('@')) return undefined;
  const cleaned = display
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned === '' ? undefined : cleaned;
}

const KOREAN_SUFFIX = /주식회사|유한회사|\(주\)|㈜/g;
const LATIN_SUFFIX = /(?:^|[\s.,])(?:inc|llc|ltd|pbc|corp|co|gmbh)(?=$|[\s.,])/g;

/** Lowercase letters and digits only, with company suffixes dropped, for merchant matching. */
export function merchantKeyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(KOREAN_SUFFIX, ' ')
    .replace(LATIN_SUFFIX, ' ')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Classifies a mail as a stored document, or undefined when it is marketing or not a document. */
export function classifyDocument(input: ClassifyInput): DocumentClass | undefined {
  const body = input.body.slice(0, BODY_CHARS);
  const haystack = `${input.subject}\n${input.from}\n${body}`;
  if (MARKETING.some((pattern) => pattern.test(haystack))) return undefined;

  const kind = kindOf(haystack);
  if (kind === undefined) return undefined;

  const money = preferredMoney(`${input.subject}\n${body}`);
  const merchant = cleanMerchant(input.from);
  const merchantKey = merchant === undefined ? undefined : merchantKeyOf(merchant);
  return {
    kind,
    ...(money !== undefined ? { amount: money.amount, currency: money.currency } : {}),
    ...(merchant !== undefined ? { merchant } : {}),
    ...(merchantKey !== undefined && merchantKey !== '' ? { merchantKey } : {}),
  };
}
