import type {
  DraftAttachment,
  MailAttachment,
  MailAttachmentReader,
  MailAwaitingReply,
  MailDraft,
  MailDrafter,
  MailLabel,
  MailMessage,
  MailOrganizer,
  MailPage,
  MailQuery,
  MailReader,
  MailSender,
  MailSummary,
} from '../../core/contracts/mail.js';
import { joinId, splitId } from './accounts.js';
import { fromAll } from './account-services.js';
import type { AccountService } from './account-services.js';

type Mailbox = MailReader & MailDrafter & MailSender & MailAwaitingReply;
type Accounts<T> = () => Promise<AccountService<T>[]>;

function tagged<T extends MailSummary>(item: AccountService<unknown>, mail: T): T {
  return { ...mail, id: joinId(item.account.key, mail.id), threadId: joinId(item.account.key, mail.threadId), account: item.label };
}

const newestFirst = (a: MailSummary, b: MailSummary): number => b.receivedAt.getTime() - a.receivedAt.getTime();

async function pick<T>(accounts: Accounts<T>, id: string): Promise<{ service: T; id: string; item: AccountService<T> }> {
  const { key, id: own } = splitId(id);
  const item = (await accounts()).find((entry) => entry.account.key === key);
  if (item === undefined) throw new Error('그 메일이 있던 구글 계정이 지금은 연결돼 있지 않아요.');
  return { service: item.service, id: own, item };
}

function encodePages(state: Record<string, string | null>): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodePages(token: string | undefined): Record<string, string | null> | undefined {
  if (token === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string | null>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gmail over every connected account: searches ask each one and merge newest first, and an id names its account, so
 * reading, replying and sending stay in the mailbox the mail came from. With one account it is that mailbox, unchanged.
 */
export class MultiMail implements MailReader, MailDrafter, MailSender, MailAwaitingReply {
  constructor(private readonly accounts: Accounts<Mailbox>) {}

  async search(query: MailQuery): Promise<MailSummary[]> {
    const all = await this.accounts();
    if (all.length === 1 && all[0] !== undefined) return await all[0].service.search(query);
    const found = await fromAll(all, async (item) => await item.service.search(query));
    return found.flatMap(({ item, value }) => value.map((mail) => tagged(item, mail))).sort(newestFirst).slice(0, query.limit);
  }

  async searchPage(query: MailQuery, pageToken?: string): Promise<MailPage> {
    const all = await this.accounts();
    if (all.length === 1 && all[0] !== undefined) {
      const only = all[0].service;
      return only.searchPage !== undefined ? await only.searchPage(query, pageToken) : { messages: await only.search(query) };
    }
    const state = decodePages(pageToken) ?? Object.fromEntries(all.map((item) => [item.account.key, '']));
    const open = all.filter((item) => typeof state[item.account.key] === 'string');
    const pages = await fromAll(open, async (item) => {
      const token = state[item.account.key] ?? '';
      return item.service.searchPage !== undefined ? await item.service.searchPage(query, token === '' ? undefined : token) : { messages: await item.service.search(query) };
    });
    const next: Record<string, string | null> = Object.fromEntries(all.map((item) => [item.account.key, null]));
    for (const { item, value } of pages) next[item.account.key] = value.nextPageToken ?? null;
    const messages = pages.flatMap(({ item, value }) => value.messages.map((mail) => tagged(item, mail))).sort(newestFirst);
    return { messages, ...(Object.values(next).some((token) => token !== null) ? { nextPageToken: encodePages(next) } : {}) };
  }

  async read(id: string): Promise<MailMessage> {
    const { service, id: own, item } = await pick(this.accounts, id);
    const mail = await service.read(own);
    return (await this.accounts()).length > 1 ? tagged(item, mail) : mail;
  }

  async draftReply(messageId: string, body: string, attachments?: readonly DraftAttachment[]): Promise<MailDraft> {
    const { service, id, item } = await pick(this.accounts, messageId);
    const draft = await service.draftReply(id, body, attachments);
    return { ...draft, draftId: joinId(item.account.key, draft.draftId) };
  }

  async getDraft(draftId: string): Promise<MailDraft> {
    const { service, id, item } = await pick(this.accounts, draftId);
    const draft = await service.getDraft(id);
    return { ...draft, draftId: joinId(item.account.key, draft.draftId) };
  }

  async sendDraft(draftId: string): Promise<{ messageId: string }> {
    const { service, id, item } = await pick(this.accounts, draftId);
    const sent = await service.sendDraft(id);
    return { messageId: joinId(item.account.key, sent.messageId) };
  }

  async awaitingReply(query: { olderThanHours: number; newerThanDays: number; limit: number }): Promise<MailSummary[]> {
    const all = await this.accounts();
    if (all.length === 1 && all[0] !== undefined) return await all[0].service.awaitingReply(query);
    const found = await fromAll(all, async (item) => await item.service.awaitingReply(query));
    return found.flatMap(({ item, value }) => value.map((mail) => tagged(item, mail))).sort(newestFirst).slice(0, query.limit);
  }
}

export class MultiAttachments implements MailAttachmentReader {
  constructor(private readonly accounts: Accounts<MailAttachmentReader>) {}

  async list(messageId: string): Promise<MailAttachment[]> {
    const { service, id } = await pick(this.accounts, messageId);
    return await service.list(id);
  }

  async download(messageId: string, attachmentId: string, maxBytes: number): Promise<Uint8Array> {
    const { service, id } = await pick(this.accounts, messageId);
    return await service.download(id, attachmentId, maxBytes);
  }
}

/** Organizing over accounts: the ids are grouped by account; labels are the first account's, made where missing. */
export class MultiOrganizer implements MailOrganizer {
  constructor(private readonly accounts: Accounts<MailOrganizer>) {}

  private async groups(ids: readonly string[]): Promise<{ item: AccountService<MailOrganizer>; ids: string[] }[]> {
    const all = await this.accounts();
    const byKey = new Map<string, string[]>();
    for (const id of ids) {
      const { key, id: own } = splitId(id);
      byKey.set(key, [...(byKey.get(key) ?? []), own]);
    }
    return all.flatMap((item) => {
      const own = byKey.get(item.account.key);
      return own === undefined ? [] : [{ item, ids: own }];
    });
  }

  async labels(): Promise<MailLabel[]> {
    const first = (await this.accounts())[0];
    return first === undefined ? [] : await first.service.labels();
  }

  async peek(ids: readonly string[]): Promise<MailSummary[]> {
    const multi = (await this.accounts()).length > 1;
    const seen = await Promise.all((await this.groups(ids)).map(async ({ item, ids: own }) => (await item.service.peek(own)).map((mail) => (multi ? tagged(item, mail) : mail))));
    return seen.flat();
  }

  async archive(ids: readonly string[]): Promise<void> {
    for (const { item, ids: own } of await this.groups(ids)) await item.service.archive(own);
  }

  async addLabels(ids: readonly string[], labelNames: readonly string[]): Promise<void> {
    for (const { item, ids: own } of await this.groups(ids)) {
      // a label the owner made lives in the first account; another account gets one with the same name
      if (item.account.key !== '') for (const name of labelNames) await item.service.createLabel(name);
      await item.service.addLabels(own, labelNames);
    }
  }

  async removeLabels(ids: readonly string[], labelNames: readonly string[]): Promise<void> {
    for (const { item, ids: own } of await this.groups(ids)) await item.service.removeLabels(own, labelNames);
  }

  async createLabel(name: string): Promise<MailLabel> {
    const first = (await this.accounts())[0];
    if (first === undefined) throw new Error('연결된 구글 계정이 없어요.');
    return await first.service.createLabel(name);
  }
}
