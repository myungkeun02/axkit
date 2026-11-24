import { moneyOf, preferredMoney } from './classify.js';

/** What a receipt image or PDF shows. Every field is optional; a scan may omit or misread any of them. */
export interface ReceiptInfo {
  amount?: number;
  currency?: string;
  merchant?: string;
  /** Calendar date, YYYY-MM-DD. */
  date?: string;
}

const TOTAL_LABEL = /합계|총\s*액|총\s*결제|결제\s*금액|받을\s*금액|승인\s*금액|\btotal\b|\bamount\s+due\b/i;
const KO_MERCHANT_LABEL = /^\s*(?:가맹점|상호|매장)\s*명?\s*[:：]?\s*(.+)$/;
const EN_MERCHANT_LABEL = /^\s*(?:merchant|store)\s*(?:name)?\s*[:#]?\s*(.+)$/i;
const GENERIC = /영수증|가맹점|상호|매장|합계|총\s*액|금액|받을|승인|카드|결제|완료|부가세|감사합니다|\breceipt\b|\bmerchant\b|\bstore\b|\btotal\b|\bamount\b|\bcard\b|\bapproved?\b|\bpayment\b|\bvat\b|\bthank/i;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const MAX_MERCHANT = 60;

const NUMERIC_DATE = /(\d{4})[-./](\d{1,2})[-./](\d{1,2})/;
const KOREAN_DATE = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
const MONTH_NAME_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i;
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function validDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

interface Candidate {
  index: number;
  value: string;
}

/** First readable date in the text. OCR sometimes glues the time right after the day ("2026-11-1514:32"). */
function dateOf(text: string): string | undefined {
  const candidates: Candidate[] = [];
  const push = (regex: RegExp, build: (match: RegExpExecArray) => string | undefined): void => {
    const match = regex.exec(text);
    if (match === null) return;
    const value = build(match);
    if (value !== undefined) candidates.push({ index: match.index, value });
  };

  push(NUMERIC_DATE, (match) => validDate(Number(match[1]), Number(match[2]), Number(match[3])));
  push(KOREAN_DATE, (match) => validDate(Number(match[1]), Number(match[2]), Number(match[3])));
  push(MONTH_NAME_DATE, (match) => {
    const month = MONTHS[(match[1] ?? '').toLowerCase()];
    const year = match[3];
    if (month === undefined || year === undefined) return undefined;
    return validDate(Number(year), month, Number(match[2]));
  });

  candidates.sort((left, right) => left.index - right.index);
  return candidates[0]?.value;
}

function bareAmount(line: string): number | undefined {
  // Dates and times on a labelled line are not the total; drop them before taking the last number.
  const cleaned = line.replace(NUMERIC_DATE, ' ').replace(KOREAN_DATE, ' ').replace(/\d{1,2}:\d{2}/g, ' ');
  const matches = [...cleaned.matchAll(NUMBER)];
  const last = matches.at(-1)?.[0];
  if (last === undefined) return undefined;
  const value = Number(last.replaceAll(',', ''));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function totalOf(text: string): { amount: number; currency?: string } | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!TOTAL_LABEL.test(line)) continue;
    const money = moneyOf(line);
    if (money !== undefined) return money;
    const bare = bareAmount(line);
    if (bare !== undefined) {
      return { amount: bare, ...(line.includes('원') ? { currency: 'KRW' } : {}) };
    }
  }
  return preferredMoney(text);
}

function cleanLine(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’:：-]+|["'“”‘’:：-]+$/g, '')
    .trim()
    .slice(0, MAX_MERCHANT)
    .trim();
}

function labelMerchant(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = KO_MERCHANT_LABEL.exec(line) ?? EN_MERCHANT_LABEL.exec(line);
    if (match === null) continue;
    const value = cleanLine(match[1] ?? '');
    if (value !== '') return value;
  }
  return undefined;
}

function firstNamedLine(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const value = cleanLine(line);
    if (value === '') continue;
    if (/\d/.test(value)) continue;
    if (GENERIC.test(value)) continue;
    return value;
  }
  return undefined;
}

/** Amount, currency, merchant and date shown on a receipt, preferring labelled totals and merchant fields. */
export function receiptFromText(text: string): ReceiptInfo {
  const lines = text.split(/\r?\n/);
  const total = totalOf(text);
  const merchant = labelMerchant(lines) ?? firstNamedLine(lines);
  const date = dateOf(text);
  return {
    ...(total !== undefined ? { amount: total.amount } : {}),
    ...(total?.currency !== undefined ? { currency: total.currency } : {}),
    ...(merchant !== undefined ? { merchant } : {}),
    ...(date !== undefined ? { date } : {}),
  };
}
