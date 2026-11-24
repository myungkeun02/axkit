import type { PaymentNotice } from '../../../core/contracts/index.js';

export interface ParsedPayment {
  kind: 'approve' | 'cancel';
  merchant: string;
  /** Charged amount, always positive; the sign comes from `kind`. */
  amount: number;
  /** ISO 4217 code of the charged amount. */
  currency: string;
  at: Date;
  card?: string;
  installmentMonths?: number;
  /** The home-currency amount printed on an overseas notice, when the card company stated it. */
  statedHomeAmount?: number;
}

/** One notice shape (a card company, a receipt mail). Parsers are data-only; none of them pays or replies. */
export interface PaymentParser {
  id: string;
  accepts(notice: PaymentNotice): boolean;
  parse(notice: PaymentNotice, timeZone: string): ParsedPayment | undefined;
}
