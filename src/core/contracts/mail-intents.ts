import type { MailMessage } from './mail.js';

/** Kinds every owner's mail falls into; packs add their own (§ talent: hiring requests, applications). */
export const BASE_MAIL_KINDS = ['question', 'document_request', 'scheduling', 'introduction', 'notice', 'other'] as const;

export interface MailIntent {
  /** snake_case, unique: "hiring_request". */
  id: string;
  /** For the triage model: when a mail is this kind, one sentence in English. */
  description: string;
  /**
   * Facts for the reply draft (matching candidates, a price list), plain text without contact details. Undefined
   * when there is nothing useful to add.
   */
  context?(mail: MailMessage, summary: string): Promise<string | undefined>;
  /** Work besides the reply (read the attached résumés). Returns a line for the owner's notice, if any. */
  handle?(mail: MailMessage, summary: string): Promise<string | undefined>;
}

/** Capability "mail.intents", provided by skill.mail: packs register kinds of mail they know how to handle. */
export interface MailIntentRegistry {
  register(intent: MailIntent): void;
  list(): readonly MailIntent[];
}

/** One inbox mail the triage read (not forged): the summary other skills (standing orders) look at. */
export interface MailTriaged {
  id: string;
  from: string;
  subject: string;
  /** The triage model's one sentence. */
  summary: string;
  kind: string;
  importance: 'high' | 'normal' | 'low';
}

declare module '../events/types.js' {
  interface EventMap {
    'mail.triaged': MailTriaged;
  }
}
