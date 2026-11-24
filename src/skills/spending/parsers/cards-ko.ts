import type { PaymentNotice } from '../../../core/contracts/index.js';
import { zonedIso } from '../../../core/time/date-spec.js';
import { ymdOf } from '../../../core/time/local-day.js';
import { cleanMerchant } from '../normalize.js';
import { findAmounts } from './amount.js';
import type { ParsedPayment, PaymentParser } from './types.js';

interface CardCompany {
  id: string;
  card: string;
  channel: RegExp;
}

export const CARD_COMPANIES: readonly CardCompany[] = [
  { id: 'hyundai', card: '현대카드', channel: /현대카드/ },
  { id: 'shinhan', card: '신한카드', channel: /신한카드|신한\s*SOL/ },
  { id: 'samsung', card: '삼성카드', channel: /삼성카드/ },
  { id: 'kb', card: 'KB국민카드', channel: /KB\s*국민카드|국민카드/i },
  { id: 'lotte', card: '롯데카드', channel: /롯데카드/ },
  { id: 'hana', card: '하나카드', channel: /하나카드/ },
  { id: 'woori', card: '우리카드', channel: /우리카드/ },
  { id: 'bc', card: 'BC카드', channel: /BC카드|비씨카드/i },
  { id: 'nh', card: 'NH농협카드', channel: /NH\s*농협카드|농협카드/i },
  { id: 'kakao', card: '카카오뱅크', channel: /카카오뱅크/ },
  { id: 'toss', card: '토스뱅크', channel: /토스뱅크/ },
  { id: 'kbank', card: '케이뱅크', channel: /케이뱅크/ },
];

const NOT_A_PAYMENT = /인증번호|거절|한도\s*초과|미승인|결제\s*예정|명세서|청구\s*예정|이벤트|혜택|\(광고\)/;
const PAYMENT_WORD = /승인|사용|결제|취소/;
const LABELLED_STAMP = /(?:승인)?\s*일시\s*[:：]?\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/;
const PLAIN_STAMP = /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/;
const MERCHANT_LABEL = /(?:가맹점명?|이용\s*가맹점|사용처)\s*[:：]?\s*([^\n]+)/;
const MERCHANT_STOP = /\s*(?:누적|잔액|사용가능|■)/;
const BALANCE_AMOUNT = /(?:누적|잔액|잔여|사용가능|한도|포인트)[^\d\n]{0,10}[\d,.]+\s*(?:원|KRW)?/g;
const INSTALLMENT = /(\d{1,2})\s*개월/;
const CANCEL = /취소/;
const TWO_DAYS_MS = 2 * 86_400_000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function headOf(notice: PaymentNotice): string {
  const text = notice.text.replace(/^\s*\[Web발신\]\s*/i, '');
  return text.split('\n').slice(0, 2).join('\n');
}

function accepts(notice: PaymentNotice, company: CardCompany): boolean {
  if (notice.sender !== undefined && company.channel.test(notice.sender)) return true;
  if (notice.title !== undefined && company.channel.test(notice.title)) return true;
  return company.channel.test(headOf(notice));
}

function wallDate(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  try {
    return new Date(zonedIso(`${year}-${pad2(month)}-${pad2(day)}`, `${pad2(hour)}:${pad2(minute)}`, timeZone));
  } catch {
    return undefined;
  }
}

function stampedAt(notice: PaymentNotice, timeZone: string, text: string): { at: Date; end: number } | undefined {
  const labelled = LABELLED_STAMP.exec(text);
  const match = labelled ?? PLAIN_STAMP.exec(text);
  if (match === null) return undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const receivedYear = Number(ymdOf(notice.at, timeZone).slice(0, 4));
  let at = wallDate(receivedYear, month, day, hour, minute, timeZone);
  if (at === undefined) return undefined;
  // A 12/31 notice that arrives on Jan 1 belongs to the previous year.
  if (at.getTime() > notice.at.getTime() + TWO_DAYS_MS) {
    at = wallDate(receivedYear - 1, month, day, hour, minute, timeZone) ?? at;
  }
  return { at, end: (match.index ?? 0) + match[0].length };
}

function merchantAt(text: string, stampEnd: number | undefined): string {
  const labelled = MERCHANT_LABEL.exec(text)?.[1];
  if (labelled !== undefined) return cleanMerchant(labelled.split(MERCHANT_STOP)[0] ?? '');
  if (stampEnd === undefined) return '';
  const rest = text.slice(stampEnd);
  const sameLine = (rest.split('\n')[0] ?? '').trim();
  if (sameLine !== '') return cleanMerchant(sameLine.split(MERCHANT_STOP)[0] ?? '');
  const next = rest
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line !== '');
  return next === undefined ? '' : cleanMerchant(next);
}

function lengthMonths(text: string): number | undefined {
  const match = INSTALLMENT.exec(text);
  if (match === null) return undefined;
  const months = Number(match[1]);
  return months >= 1 && months <= 60 ? months : undefined;
}

function chargedAmounts(text: string): ReturnType<typeof findAmounts> {
  return findAmounts(text.replace(BALANCE_AMOUNT, ' '));
}

function parseCard(notice: PaymentNotice, timeZone: string, card: string): ParsedPayment | undefined {
  const text = notice.text.replace(/\[Web발신\]/gi, ' ');
  if (NOT_A_PAYMENT.test(text) || !PAYMENT_WORD.test(text)) return undefined;

  const amounts = chargedAmounts(text);
  const foreign = amounts.find((amount) => amount.currency !== 'KRW');
  const krw = amounts.find((amount) => amount.currency === 'KRW');
  const charged = foreign ?? krw;
  if (charged === undefined) return undefined;

  const stamp = stampedAt(notice, timeZone, text);
  const merchant = merchantAt(text, stamp?.end);
  if (merchant === '' || /^\d+$/.test(merchant)) return undefined;

  const months = lengthMonths(text);
  const statedHomeAmount = foreign !== undefined && krw !== undefined ? krw.amount : undefined;
  return {
    kind: CANCEL.test(text) ? 'cancel' : 'approve',
    merchant,
    amount: charged.amount,
    currency: charged.currency,
    at: stamp?.at ?? notice.at,
    card,
    ...(months !== undefined ? { installmentMonths: months } : {}),
    ...(statedHomeAmount !== undefined ? { statedHomeAmount } : {}),
  };
}

function parserFor(company: CardCompany): PaymentParser {
  return {
    id: `card-ko:${company.id}`,
    accepts: (notice) => accepts(notice, company),
    parse: (notice, timeZone) => parseCard(notice, timeZone, company.card),
  };
}

export const CARD_PARSERS: readonly PaymentParser[] = CARD_COMPANIES.map(parserFor);
