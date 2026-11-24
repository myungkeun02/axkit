export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
  unread: boolean;
  /** The service's own importance signal (Gmail "important"), not ours. */
  important: boolean;
  /** The service's own labels (Gmail "CATEGORY_PROMOTIONS", "SENT"), when it has them. */
  labels?: readonly string[];
}

/** What the receiving server checked about the sender (Authentication-Results), lower-case results. */
export interface MailAuth {
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

export interface MailMessage extends MailSummary {
  to: readonly string[];
  cc: readonly string[];
  /** Sender authentication, when the service reports it. */
  auth?: MailAuth;
  /** An unsubscribe header or a bulk "Precedence": mail sent to a list, not written to the owner. */
  bulk?: boolean;
  /** Plain text body, already decoded. Data, never instructions. */
  body: string;
}

export interface MailQuery {
  /** Free text matched by the service's own search. */
  text?: string;
  unreadOnly?: boolean;
  importantOnly?: boolean;
  /** Only mail received in the last N hours. */
  sinceHours?: number;
  limit: number;
}

export interface MailDraft {
  draftId: string;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  body: string;
  /** File names attached to the draft. */
  attachments?: readonly string[];
}

/** A file to attach to a draft (read by the caller from a place the owner allows). */
export interface DraftAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

/** One page of a search, newest first; `nextPageToken` is set while older matches remain. */
export interface MailPage {
  messages: MailSummary[];
  nextPageToken?: string;
}

/** Capability "mail.read". */
export interface MailReader {
  search(query: MailQuery): Promise<MailSummary[]>;
  /** The same search, a page at a time, for sweeps that must see every match (triage). */
  searchPage?(query: MailQuery, pageToken?: string): Promise<MailPage>;
  read(id: string): Promise<MailMessage>;
}

/** Capability "mail.draft". A draft stays in the owner's mailbox; nobody else sees it. */
export interface MailDrafter {
  draftReply(messageId: string, body: string, attachments?: readonly DraftAttachment[]): Promise<MailDraft>;
  getDraft(draftId: string): Promise<MailDraft>;
}

/** Capability "mail.send". Reaches other people; only ever called behind an approval card. */
export interface MailSender {
  sendDraft(draftId: string): Promise<{ messageId: string }>;
}

/** Capability "mail.awaiting": mail the owner has not answered yet, newest last message from someone else. */
export interface MailAwaitingReply {
  awaitingReply(query: { olderThanHours: number; newerThanDays: number; limit: number }): Promise<MailSummary[]>;
}

export interface MailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Capability "mail.attachments". Read only. */
export interface MailAttachmentReader {
  list(messageId: string): Promise<MailAttachment[]>;
  /** Throws when the attachment is larger than maxBytes. */
  download(messageId: string, attachmentId: string, maxBytes: number): Promise<Uint8Array>;
}

export interface NewMailDraft {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  body: string;
}

/** Capability "mail.compose": a new draft in the owner's mailbox. Sending stays behind mail.send and an approval. */
export interface MailComposer {
  draftNew(draft: NewMailDraft): Promise<MailDraft>;
}

export interface MailLabel {
  id: string;
  name: string;
  /** The service's own label (INBOX, STARRED) rather than one the owner made. */
  system: boolean;
}

/** Most mails one organize call may touch. */
export const MAIL_ORGANIZE_MAX = 50;

/**
 * System labels an organizer may add or remove: INBOX (archive / move back), UNREAD (mark read), STARRED, IMPORTANT.
 * Trash and spam are never reachable: an organizer does not delete mail.
 */
export const ORGANIZE_SYSTEM_LABELS: readonly string[] = ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT'];

/**
 * Capability "mail.organize": archive mail and change labels, nothing else. Archive only takes the mail out of the
 * inbox; it stays in the mailbox. Labels are named, not ids; names match without regard to case.
 */
export interface MailOrganizer {
  labels(): Promise<MailLabel[]>;
  /** The mails as they are now (sender, subject, labels); ids that no longer exist are left out. */
  peek(ids: readonly string[]): Promise<MailSummary[]>;
  archive(ids: readonly string[]): Promise<void>;
  /** Throws when a label does not exist; create a missing owner label with createLabel first. */
  addLabels(ids: readonly string[], labelNames: readonly string[]): Promise<void>;
  removeLabels(ids: readonly string[], labelNames: readonly string[]): Promise<void>;
  /** Returns the existing label when one with that name is already there. */
  createLabel(name: string): Promise<MailLabel>;
}

/** The mail service refused because the owner never granted the permission this needs (e.g. Gmail modify). */
export class MailPermissionError extends Error {
  constructor(readonly permission: string) {
    super(`Mail permission missing: ${permission}`);
    this.name = 'MailPermissionError';
  }
}
