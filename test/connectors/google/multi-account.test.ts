import { describe, expect, it } from 'vitest';
import type { MailSummary } from '../../../src/core/contracts/mail.js';
import type { CalendarEvent } from '../../../src/core/contracts/calendar.js';
import { joinId, readAccountList, splitId } from '../../../src/connectors/google/accounts.js';
import type { AccountService } from '../../../src/connectors/google/account-services.js';
import { removeGoogleAccount } from '../../../src/connectors/google/connect-account.js';
import { MultiCalendar } from '../../../src/connectors/google/multi-calendar.js';
import { MultiMail } from '../../../src/connectors/google/multi-mail.js';

const mail = (id: string, hoursAgo: number): MailSummary => ({ id, threadId: `t-${id}`, from: 'a@x.test', subject: id, snippet: '', receivedAt: new Date(Date.UTC(2026, 10, 24, 12 - hoursAgo)), unread: true, important: false });

function mailbox(messages: MailSummary[], calls: string[] = []) {
  return {
    search: async () => messages,
    read: async (id: string) => ({ ...(messages.find((m) => m.id === id) ?? mail(id, 0)), to: [], cc: [], body: '' }),
    draftReply: async (id: string) => (calls.push(`draft ${id}`), { draftId: `d-${id}`, to: [], cc: [], subject: '', body: '' }),
    getDraft: async (id: string) => ({ draftId: id, to: [], cc: [], subject: '', body: '' }),
    sendDraft: async (id: string) => (calls.push(`send ${id}`), { messageId: `m-${id}` }),
    awaitingReply: async () => messages,
  };
}

const two = <T>(first: T, second: T): (() => Promise<AccountService<T>[]>) => async () => [
  { account: { key: '', email: 'me@x.test' }, label: 'me@x.test', service: first },
  { account: { key: 'a2', email: 'work@y.test' }, label: 'work@y.test', service: second },
];

describe('more than one Google account', () => {
  it('names the account in ids, and the first one keeps plain ids', () => {
    expect(joinId('', 'abc')).toBe('abc');
    expect(splitId(joinId('a2', 'abc'))).toEqual({ key: 'a2', id: 'abc' });
    expect(splitId('a2b~x')).toEqual({ key: '', id: 'a2b~x' });
  });

  it('merges searches newest first with the account, and replies from the mailbox the mail is in', async () => {
    const workCalls: string[] = [];
    const multi = new MultiMail(two(mailbox([mail('old', 5)]), mailbox([mail('new', 1)], workCalls)));
    const found = await multi.search({ limit: 10 });
    expect(found.map((m) => [m.id, m.account])).toEqual([['a2~new', 'work@y.test'], ['old', 'me@x.test']]);
    const draft = await multi.draftReply('a2~new', 'ok');
    expect(draft.draftId).toBe('a2~d-new');
    expect(await multi.sendDraft(draft.draftId)).toEqual({ messageId: 'a2~m-d-new' });
    expect(workCalls).toEqual(['draft new', 'send d-new']);
  });

  it('is the one mailbox unchanged when only one account is connected', async () => {
    const multi = new MultiMail(async () => [{ account: { key: '', email: '' }, label: '기본 계정', service: mailbox([mail('x', 1)]) }]);
    expect((await multi.search({ limit: 5 }))[0]).not.toHaveProperty('account');
  });

  it('still answers when one account fails', async () => {
    const broken = { ...mailbox([]), search: async () => Promise.reject(new Error('expired')) };
    const multi = new MultiMail(two(broken, mailbox([mail('w', 1)])));
    expect((await multi.search({ limit: 5 })).map((m) => m.id)).toEqual(['a2~w']);
  });

  it('merges calendars by start and creates on the first account', async () => {
    const event = (id: string, start: string): CalendarEvent => ({ id, title: id, start, end: start, allDay: false });
    const created: string[] = [];
    const reader = (events: CalendarEvent[]) => ({ listEvents: async () => events });
    const multi = new MultiCalendar(two(reader([event('late', '2026-11-24T15:00:00+09:00')]), reader([event('early', '2026-11-24T09:00:00+09:00')])), {
      createEvent: async (draft) => (created.push(draft.title), event('new', draft.start)),
    });
    expect((await multi.listEvents({ from: new Date(), to: new Date() })).map((e) => [e.id, e.account])).toEqual([['a2~early', 'work@y.test'], ['late', 'me@x.test']]);
    await multi.createEvent({ title: 'meet', start: '2026-11-25T10:00:00+09:00', end: '2026-11-25T11:00:00+09:00', allDay: false });
    expect(created).toEqual(['meet']);
  });

  it('removes an added account but never the first', async () => {
    const store = new Map<string, string>([
      ['google.accounts', JSON.stringify({ primary: 'me@x.test', extra: [{ key: 'a2', email: 'work@y.test' }] })],
      ['google.refresh-token.a2', 'r2'],
    ]);
    const secrets = { get: async (n: string) => store.get(n), set: async (n: string, v: string) => void store.set(n, v), delete: async (n: string) => void store.delete(n), has: async (n: string) => store.has(n) };
    expect((await removeGoogleAccount({ secrets }, 'me@x.test')).ok).toBe(false);
    expect((await removeGoogleAccount({ secrets }, 'WORK@y.test')).ok).toBe(true);
    expect(store.has('google.refresh-token.a2')).toBe(false);
    expect((await readAccountList(secrets)).extra).toEqual([]);
  });
});
