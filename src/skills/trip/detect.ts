import { EN_BOOKING_WORDS, EN_CANCEL_WORDS, EN_PROMO_WORDS, EN_STRONG_WORDS } from './detect-en.js';
import { KO_BOOKING_WORDS, KO_CANCEL_WORDS, KO_PROMO_WORDS, KO_STRONG_WORDS } from './detect-ko.js';

export type BookingSignal = 'booking' | 'cancel';

export interface MailText {
  from: string;
  subject: string;
  body: string;
}

const BODY_CHARS = 2_000;

function compact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function hasKo(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(compact(word)));
}

function hasEn(text: string, words: readonly string[]): boolean {
  return words.some((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
}

function detectKo(text: string): BookingSignal | undefined {
  const flat = compact(text);
  const cancel = hasKo(flat, KO_CANCEL_WORDS);
  const strong = hasKo(flat, KO_STRONG_WORDS);
  const promo = hasKo(flat, KO_PROMO_WORDS);
  if (promo && !strong && !cancel) return undefined;
  if (cancel) return 'cancel';
  return hasKo(flat, KO_BOOKING_WORDS) ? 'booking' : undefined;
}

function detectEn(text: string): BookingSignal | undefined {
  const cancel = hasEn(text, EN_CANCEL_WORDS);
  const strong = hasEn(text, EN_STRONG_WORDS);
  const promo = hasEn(text, EN_PROMO_WORDS);
  if (promo && !strong && !cancel) return undefined;
  if (cancel) return 'cancel';
  return hasEn(text, EN_BOOKING_WORDS) ? 'booking' : undefined;
}

/** Booking or cancellation confirmation from subject, sender or the first 2000 body characters. */
export function detectBooking(mail: MailText): BookingSignal | undefined {
  const text = `${mail.subject}\n${mail.from}\n${mail.body.slice(0, BODY_CHARS)}`.toLowerCase();
  const ko = detectKo(text);
  const en = detectEn(text);
  if (ko === 'cancel' || en === 'cancel') return 'cancel';
  if (ko === 'booking' || en === 'booking') return 'booking';
  return undefined;
}
