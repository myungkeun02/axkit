import type { PaymentNotice } from '../../../core/contracts/index.js';
import { CARD_PARSERS } from './cards-ko.js';
import { mailReceiptParser } from './mail-receipt.js';
import type { ParsedPayment, PaymentParser } from './types.js';

/** Ordered registry. A language pack can append parsers without touching the pipeline. */
export const PARSERS: readonly PaymentParser[] = [...CARD_PARSERS, mailReceiptParser];

/** The first parser that both accepts the notice and understands it. */
export function parseNotice(notice: PaymentNotice, timeZone: string): ParsedPayment | undefined {
  for (const parser of PARSERS) {
    if (!parser.accepts(notice)) continue;
    const parsed = parser.parse(notice, timeZone);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}
