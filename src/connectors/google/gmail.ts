import type {
  MailAwaitingReply,
  DraftAttachment,
  MailAuth,
  MailDraft,
  MailDrafter,
  MailMessage,
  MailPage,
  MailQuery,
  MailReader,
  MailSender,
  MailSummary,
} from '../../core/contracts/mail.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';
import { buildReplyMime, encodeBase64Url, attachmentNames, extractPlainText, replySubject } from './mime.js';
import type { GmailPayload } from './mime.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 20_000;
const MAX_SEARCH_RESULTS = 500;

export interface GoogleMailOptions {
  request: GoogleRequestFn;
  clock: Clock;
}

export interface RawMessage {
  id?: unknown;
  threadId?: unknown;
  labelIds?: unknown;
  snippet?: unknown;
  internalDate?: unknown;
  payload?: GmailPayload;
}

/** "mx.google.com; dkim=pass header.i=@a.com; spf=softfail …; dmarc=fail …" → {dkim:'pass', spf:'softfail', dmarc:'fail'}. */
export function authOf(results: string | undefined): { auth?: MailAuth } {
  if (results === undefined) return {};
  const auth: MailAuth = {};
  for (const key of ['spf', 'dkim', 'dmarc'] as const) {
    const match = new RegExp(`\\b${key}=([a-z]+)`, 'i').exec(results);
    if (match?.[1] !== undefined) auth[key] = match[1].toLowerCase();
  }
  return Object.keys(auth).length > 0 ? { auth } : {};
}

function header(payload: GmailPayload | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const entry of payload?.headers ?? []) {
    if (typeof entry.name === 'string' && entry.name.toLowerCase() === wanted && typeof entry.value === 'string') {
      return entry.value;
    }
  }
  return undefined;
}

function splitAddresses(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function labels(raw: RawMessage): string[] {
  return Array.isArray(raw.labelIds) ? raw.labelIds.filter((label): label is string => typeof label === 'string') : [];
}

function receivedAt(raw: RawMessage): Date {
  const value = typeof raw.internalDate === 'string' ? Number(raw.internalDate) : Number.NaN;
  return new Date(Number.isFinite(value) ? value : 0);
}

export function toSummary(raw: RawMessage): MailSummary | undefined {
  if (typeof raw.id !== 'string' || raw.id === '') return undefined;
  if (typeof raw.threadId !== 'string' || raw.threadId === '') return undefined;
  const messageLabels = labels(raw);
  return {
    id: raw.id,
    threadId: raw.threadId,
    from: header(raw.payload, 'From') ?? '',
    subject: header(raw.payload, 'Subject') ?? '',
    snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
    receivedAt: receivedAt(raw),
    unread: messageLabels.includes('UNREAD'),
    important: messageLabels.includes('IMPORTANT'),
    ...(messageLabels.length > 0 ? { labels: messageLabels } : {}),
  };
}

function bareAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim().toLowerCase();
}

function threadQuery(olderThanHours: number, newerThanDays: number): string {
  const newerDays = Math.max(1, Math.ceil(newerThanDays));
  const olderDays = Math.max(1, Math.ceil(olderThanHours / 24));
  return [
    'in:inbox',
    '-from:me',
    '-category:promotions',
    '-category:social',
    `newer_than:${newerDays}d`,
    `older_than:${olderDays}d`,
  ].join(' ');
}

/** Gmail adapter for the signed-in user's mailbox. */
export class GoogleMail implements MailReader, MailDrafter, MailSender, MailAwaitingReply {
  private ownerAddress: string | undefined;

  constructor(private readonly deps: GoogleMailOptions) {}

  async awaitingReply(query: {
    olderThanHours: number;
    newerThanDays: number;
    limit: number;
  }): Promise<MailSummary[]> {
    if (query.limit <= 0) return [];
    const owner = await this.ownerEmail();

    const params = new URLSearchParams({
      q: threadQuery(query.olderThanHours, query.newerThanDays),
      maxResults: String(Math.min(query.limit, MAX_SEARCH_RESULTS)),
    });
    const listed = await this.deps.request<{ messages?: unknown[] }>(`${GMAIL_BASE}/messages?${params.toString()}`);
    const threadIds: string[] = [];
    for (const message of listed.messages ?? []) {
      if (!isRecord(message)) continue;
      const threadId = message.threadId;
      if (typeof threadId === 'string' && threadId !== '' && !threadIds.includes(threadId)) {
        threadIds.push(threadId);
      }
    }

    const results: MailSummary[] = [];
    for (const threadId of threadIds) {
      if (results.length >= query.limit) break;
      const thread = await this.deps.request<{ messages?: unknown[] }>(
        `${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}?format=metadata` +
          '&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date',
      );
      const messages = (thread.messages ?? []).filter(isRecord) as RawMessage[];
      const last = messages.at(-1);
      if (last === undefined) continue;
      const summary = toSummary(last);
      if (summary === undefined) continue;
      if (bareAddress(header(last.payload, 'From') ?? '') === owner) continue;
      results.push(summary);
    }
    return results;
  }

  private async ownerEmail(): Promise<string> {
    if (this.ownerAddress !== undefined) return this.ownerAddress;
    const profile = await this.deps.request<{ emailAddress?: unknown }>(`${GMAIL_BASE}/profile`);
    if (typeof profile.emailAddress !== 'string' || profile.emailAddress === '') {
      throw new Error('Gmail did not return the owner address.');
    }
    this.ownerAddress = profile.emailAddress.toLowerCase();
    return this.ownerAddress;
  }

  async search(query: MailQuery): Promise<MailSummary[]> {
    return (await this.searchPage(query)).messages;
  }

  async searchPage(query: MailQuery, pageToken?: string): Promise<MailPage> {
    if (query.limit <= 0) return { messages: [] };

    const terms: string[] = [];
    if (query.text !== undefined && query.text.trim() !== '') terms.push(query.text.trim());
    if (query.unreadOnly === true) terms.push('is:unread');
    if (query.importantOnly === true) terms.push('is:important');
    if (query.sinceHours !== undefined && query.sinceHours > 0) {
      const since = this.deps.clock.now().getTime() - query.sinceHours * 3_600_000;
      terms.push(`after:${Math.floor(since / 1000)}`);
    }

    const params = new URLSearchParams();
    if (terms.length > 0) params.set('q', terms.join(' '));
    params.set('maxResults', String(Math.min(query.limit, MAX_SEARCH_RESULTS)));
    if (pageToken !== undefined) params.set('pageToken', pageToken);

    const listed = await this.deps.request<{ messages?: unknown[]; nextPageToken?: unknown }>(`${GMAIL_BASE}/messages?${params.toString()}`);
    const ids = (listed.messages ?? []).flatMap((message) =>
      isRecord(message) && typeof message.id === 'string' && message.id !== '' ? [message.id] : [],
    );

    const results: MailSummary[] = [];
    for (const id of ids) {
      const raw = await this.fetchMessage(id, 'metadata', ['From', 'Subject', 'Date']);
      const summary = toSummary(raw);
      if (summary !== undefined) results.push(summary);
    }
    const next = typeof listed.nextPageToken === 'string' && listed.nextPageToken !== '' ? listed.nextPageToken : undefined;
    return { messages: results, ...(next !== undefined ? { nextPageToken: next } : {}) };
  }

  async read(id: string): Promise<MailMessage> {
    const raw = await this.fetchMessage(id, 'full');
    const summary = toSummary(raw);
    if (summary === undefined) throw new Error(`Gmail message ${id} was not found.`);
    return {
      ...summary,
      to: splitAddresses(header(raw.payload, 'To')),
      cc: splitAddresses(header(raw.payload, 'Cc')),
      body: raw.payload === undefined ? '' : extractPlainText(raw.payload).slice(0, MAX_BODY_CHARS),
      ...authOf(header(raw.payload, 'Authentication-Results')),
      ...(header(raw.payload, 'List-Unsubscribe') !== undefined || /^(bulk|list|junk)$/i.test(header(raw.payload, 'Precedence') ?? '') ? { bulk: true } : {}),
    };
  }

  async draftReply(messageId: string, body: string, attachments: readonly DraftAttachment[] = []): Promise<MailDraft> {
    const raw = await this.fetchMessage(messageId, 'metadata', [
      'Message-ID',
      'References',
      'Subject',
      'From',
      'Reply-To',
    ]);
    const messageHeaderId = header(raw.payload, 'Message-ID');
    const originalSubject = header(raw.payload, 'Subject') ?? '';
    const to = splitAddresses(header(raw.payload, 'Reply-To') ?? header(raw.payload, 'From'));
    const references = (header(raw.payload, 'References') ?? '').split(/\s+/).filter((value) => value !== '');
    if (messageHeaderId !== undefined && !references.includes(messageHeaderId)) references.push(messageHeaderId);

    const mime = buildReplyMime({
      to,
      subject: originalSubject,
      body,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(messageHeaderId !== undefined ? { inReplyTo: messageHeaderId } : {}),
      ...(references.length > 0 ? { references } : {}),
    });
    const threadId = typeof raw.threadId === 'string' && raw.threadId !== '' ? raw.threadId : undefined;

    const created = await this.deps.request<{ id?: unknown }>(`${GMAIL_BASE}/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          raw: encodeBase64Url(mime),
          ...(threadId !== undefined ? { threadId } : {}),
        },
      }),
    });
    if (typeof created.id !== 'string' || created.id === '') {
      throw new Error('Gmail did not return the created draft.');
    }
    return { draftId: created.id, to, cc: [], subject: replySubject(originalSubject), body, ...(attachments.length > 0 ? { attachments: attachments.map((file) => file.filename) } : {}) };
  }

  async getDraft(draftId: string): Promise<MailDraft> {
    const payload = await this.deps.request<{ id?: unknown; message?: unknown }>(
      `${GMAIL_BASE}/drafts/${encodeURIComponent(draftId)}?format=full`,
    );
    if (!isRecord(payload.message)) throw new Error(`Gmail draft ${draftId} was not found.`);
    const message = payload.message as RawMessage;
    return {
      draftId: typeof payload.id === 'string' && payload.id !== '' ? payload.id : draftId,
      to: splitAddresses(header(message.payload, 'To')),
      cc: splitAddresses(header(message.payload, 'Cc')),
      subject: header(message.payload, 'Subject') ?? '',
      body: message.payload === undefined ? '' : extractPlainText(message.payload).slice(0, MAX_BODY_CHARS),
      ...(message.payload !== undefined && attachmentNames(message.payload).length > 0 ? { attachments: attachmentNames(message.payload) } : {}),
    };
  }

  async sendDraft(draftId: string): Promise<{ messageId: string }> {
    const sent = await this.deps.request<{ id?: unknown; message?: { id?: unknown } }>(`${GMAIL_BASE}/drafts/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: draftId }),
    });
    const messageId = typeof sent.id === 'string' && sent.id !== '' ? sent.id : sent.message?.id;
    if (typeof messageId !== 'string' || messageId === '') {
      throw new Error('Gmail did not return the sent message.');
    }
    return { messageId };
  }

  private async fetchMessage(
    id: string,
    format: 'metadata' | 'full',
    metadataHeaders: readonly string[] = [],
  ): Promise<RawMessage> {
    const params = new URLSearchParams({ format });
    for (const name of metadataHeaders) params.append('metadataHeaders', name);
    return await this.deps.request<RawMessage>(
      `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?${params.toString()}`,
    );
  }
}
