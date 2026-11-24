import type { PaymentNotice } from '../../../core/contracts/index.js';
import { cleanMerchant } from '../normalize.js';
import { findAmounts } from './amount.js';
import type { AmountMatch } from './amount.js';
import type { ParsedPayment, PaymentParser } from './types.js';

const RECEIPT = /영수증|결제\s*완료|결제완료|구매\s*완료|주문\s*완료|결제\s*내역|receipt|your payment|payment received|invoice paid|order confirmation|thanks for your purchase/i;
const NOT_RECEIPT = /결제\s*예정|will be charged|upcoming|reminder|광고|newsletter/i;
const TOTAL_LINE = /total|합계|총\s*결제|결제\s*금액|amount\s*paid|charged/i;
const CANCEL = /환불|취소|refund|cancel/i;
const NOISE = /\b(?:no[-_ ]?reply|do[-_ ]?not[-_ ]?reply|receipts?|billing|invoices?|notifications?|newsletters?)\b/gi;
const MAX_AMOUNT_CHARS = 4_000;

function textOf(notice: PaymentNotice): string {
  return `${notice.title ?? ''}\n${notice.text}`;
}

function accepts(notice: PaymentNotice): boolean {
  if (notice.source !== 'mail') return false;
  const text = textOf(notice);
  return RECEIPT.test(text) && !NOT_RECEIPT.test(text);
}

function totalAmount(text: string): AmountMatch | undefined {
  const window = text.slice(0, MAX_AMOUNT_CHARS);
  for (const line of window.split('\n')) {
    if (!TOTAL_LINE.test(line)) continue;
    const amounts = findAmounts(line);
    if (amounts.length > 0) return amounts[0];
  }
  const all = findAmounts(window);
  return all.sort((left, right) => right.amount - left.amount)[0];
}

function domainLabel(sender: string): string {
  const domain = /@([^>\s]+)/.exec(sender)?.[1] ?? '';
  const labels = domain.split('.').filter((label) => label !== '');
  const label = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  return cleanMerchant(label ?? '');
}

function displayName(sender: string): string {
  const angle = /<[^>]*>/.exec(sender);
  const email = angle?.[0];
  let name = (angle === null ? sender : sender.slice(0, angle.index)).trim();
  name = name.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '');
  name = name.replace(/\s+via\s+.+$/i, '').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (name !== '' && !name.includes('@') && !/^\d+$/.test(name)) return cleanMerchant(name);
  return domainLabel(email ?? sender);
}

function merchantOf(notice: PaymentNotice): string {
  if (notice.sender === undefined || notice.sender.trim() === '') return '';
  return displayName(notice.sender);
}

function parse(notice: PaymentNotice): ParsedPayment | undefined {
  const text = textOf(notice);
  const amount = totalAmount(text);
  if (amount === undefined) return undefined;
  const merchant = merchantOf(notice);
  if (merchant === '') return undefined;
  return {
    kind: CANCEL.test(text) ? 'cancel' : 'approve',
    merchant,
    amount: amount.amount,
    currency: amount.currency,
    at: notice.at,
  };
}

export const mailReceiptParser: PaymentParser = {
  id: 'mail:receipt',
  accepts,
  parse: (notice) => parse(notice),
};
