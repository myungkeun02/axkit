import { describe, expect, it } from 'vitest';
import { GoogleMail } from '../../../src/connectors/google/gmail.js';
import { FakeClock } from '../../core/helpers.js';
import { fakeFetch, json, requestWithToken } from './helpers.js';

const START = new Date('2026-11-17T09:00:00Z');

function makeMail(fake: ReturnType<typeof fakeFetch>) {
  return new GoogleMail({ request: requestWithToken(fake, 'mail-token'), clock: new FakeClock(START) });
}

function headers(values: Record<string, string>) {
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}

function message(id: string, from: string, subject: string) {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ['UNREAD'],
    snippet: `${subject} snippet`,
    internalDate: '1763360000000',
    payload: { headers: headers({ From: from, Subject: subject }) },
  };
}

describe('GoogleMail.awaitingReply', () => {
  it('searches inbox mail and keeps threads whose last message is not from the owner', async () => {
    const fake = fakeFetch((call) => {
      if (call.url.pathname === '/gmail/v1/users/me/profile') {
        return json({ emailAddress: 'owner@example.com' });
      }
      if (call.url.pathname === '/gmail/v1/users/me/messages') {
        return json({
          messages: [
            { id: 'm1', threadId: 't1' },
            { id: 'm2', threadId: 't2' },
            { id: 'm3', threadId: 't1' },
            { id: 'm4', threadId: 't3' },
          ],
        });
      }
      if (call.url.pathname === '/gmail/v1/users/me/threads/t1') {
        return json({
          messages: [
            message('m1', '민수 <minsu@example.com>', '견적서'),
            message('m3', 'Owner <owner@example.com>', 'Re: 견적서'),
          ],
        });
      }
      if (call.url.pathname === '/gmail/v1/users/me/threads/t2') {
        return json({
          messages: [message('m2', 'Mina <mina@example.com>', '점심')],
        });
      }
      return json({
        messages: [
          message('m4', 'Mina <mina@example.com>', '질문'),
          message('m5', 'OWNER@example.com', 'Re: 질문'),
        ],
      });
    });

    const results = await makeMail(fake).awaitingReply({ olderThanHours: 24, newerThanDays: 7, limit: 5 });

    const listCall = fake.calls[1];
    expect(listCall?.url.pathname).toBe('/gmail/v1/users/me/messages');
    expect(listCall?.url.searchParams.get('q')).toBe(
      'in:inbox -from:me -category:promotions -category:social newer_than:7d older_than:1d',
    );
    expect(listCall?.url.searchParams.get('maxResults')).toBe('5');

    expect(fake.calls[2]?.url.pathname).toBe('/gmail/v1/users/me/threads/t1');
    expect(fake.calls[2]?.url.searchParams.get('format')).toBe('metadata');
    expect(fake.calls[2]?.url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject', 'Date']);

    expect(results.map((summary) => summary.id)).toEqual(['m2']);
    expect(results[0]).toMatchObject({ from: 'Mina <mina@example.com>', subject: '점심', unread: true });
    expect(fake.calls.some((call) => call.url.pathname.endsWith('/threads/t2'))).toBe(true);
    expect(fake.calls.filter((call) => call.url.pathname.startsWith('/gmail/v1/users/me/threads/'))).toHaveLength(3);
  });

  it('rounds olderThanHours up to whole days', async () => {
    const fake = fakeFetch((call) =>
      call.url.pathname === '/gmail/v1/users/me/profile'
        ? json({ emailAddress: 'owner@example.com' })
        : json({ messages: [] }),
    );
    await makeMail(fake).awaitingReply({ olderThanHours: 25, newerThanDays: 3, limit: 5 });

    expect(fake.calls[1]?.url.searchParams.get('q')).toContain('newer_than:3d older_than:2d');
  });

  it('caches the owner profile between calls', async () => {
    const fake = fakeFetch((call) =>
      call.url.pathname === '/gmail/v1/users/me/profile'
        ? json({ emailAddress: 'owner@example.com' })
        : json({ messages: [] }),
    );
    const mail = makeMail(fake);

    await mail.awaitingReply({ olderThanHours: 24, newerThanDays: 7, limit: 5 });
    await mail.awaitingReply({ olderThanHours: 24, newerThanDays: 7, limit: 5 });

    expect(fake.calls.filter((call) => call.url.pathname === '/gmail/v1/users/me/profile')).toHaveLength(1);
  });

  it('returns nothing for a non-positive limit without calling Gmail', async () => {
    const fake = fakeFetch(() => json({}));
    await expect(makeMail(fake).awaitingReply({ olderThanHours: 24, newerThanDays: 7, limit: 0 })).resolves.toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});
