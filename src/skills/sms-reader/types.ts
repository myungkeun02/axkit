import type { DateSpec, TimeSpec } from '../../core/time/date-spec.js';

export type SmsKind = 'reservation' | 'parcel' | 'bill' | 'other';

export type ReservationStatus = 'confirmed' | 'changed' | 'cancelled';

export interface ReservationFound {
  kind: 'reservation';
  status: ReservationStatus;
  /** Who the booking is with ("예시치과"), from the sender label; never a sentence from the message. */
  org?: string;
  place?: string;
  date: DateSpec;
  time?: TimeSpec;
  /** Words copied from the message that state the date (and time). */
  evidence: string;
}

export interface ParcelFound {
  kind: 'parcel';
  carrier: string;
  invoice: string;
}

export interface BillFound {
  kind: 'bill';
  /** Who bills ("KT", "관리비"), from the sender label. */
  payee?: string;
  amount?: number;
  due?: DateSpec;
  /** Words copied from the message that state the due date; present whenever `due` is. */
  evidence?: string;
}

export type Extraction = ReservationFound | ParcelFound | BillFound | { kind: 'other' };

/** What the code rules made of a message: sure, unsure (worth one cheap model call), or nothing to do. */
export type RuleResult =
  | { status: 'sure'; found: Exclude<Extraction, { kind: 'other' }> }
  | { status: 'unsure'; hint: Exclude<SmsKind, 'other' | 'parcel'> }
  | { status: 'none' };
