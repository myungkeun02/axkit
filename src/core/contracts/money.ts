export type PaymentNoticeSource = 'sms' | 'app' | 'chat' | 'mail';

/**
 * A raw payment message as it arrived: a card SMS, an app notification, a chat app's card notice or a mail receipt.
 * Data only. skill.spending's parsers turn it into a ledger entry; nothing here pays or replies.
 */
export interface PaymentNotice {
  source: PaymentNoticeSource;
  /** SMS sender, app name, chat room title or mail From. */
  sender?: string;
  /** Notification title or mail subject. */
  title?: string;
  text: string;
  at: Date;
  /** Stable id of the source message (mail id, chat event id), used to ignore the same message twice. */
  ref?: string;
}

/** Stable category ids; each language pack labels them. `ai` and `infra` are the work-tool spend most claims need. */
export const SPEND_CATEGORIES = [
  'food',
  'cafe',
  'groceries',
  'transport',
  'shopping',
  'living',
  'health',
  'culture',
  'travel',
  'education',
  'subscription',
  'ai',
  'infra',
  'transfer',
  'other',
] as const;

export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

export type CategorySource = 'rule' | 'owner' | 'model' | 'none';

export interface SpendEntry {
  id: string;
  /** ISO 8601 instant of the payment. */
  at: string;
  merchant: string;
  /** Merchant name normalized for matching ("Example, Inc." and "EXAMPLE" share one key). */
  merchantKey: string;
  /** In the owner's home currency; negative for a cancellation. */
  amount: number;
  /** ISO 4217 code of the charged currency. */
  currency: string;
  originalAmount: number;
  /** The home amount was converted with a configured rate, not stated by the card company. */
  fxEstimated?: boolean;
  card?: string;
  source: PaymentNoticeSource | 'manual';
  category: SpendCategory;
  categorySource: CategorySource;
  installmentMonths?: number;
  /** A mail receipt for the same payment was seen. */
  hasReceipt?: boolean;
  /** The owner said this is not a spend (a transfer between own accounts, a test charge). */
  excluded?: boolean;
}

/** Capability "spend.read", provided by skill.spending. Excluded entries are left out. */
export interface SpendReader {
  entries(range: { from: Date; to: Date }): Promise<SpendEntry[]>;
  homeCurrency(): string;
}

declare module '../events/types.js' {
  interface EventMap {
    'money.notice': PaymentNotice;
  }
}
