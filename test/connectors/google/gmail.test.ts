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

describe('GoogleMail.search', () => {
  it('builds the Gmail query and maps metadata results', async () => {
    const fake = fakeFetch((call) => {
      if (call.url.pathname === '/gmail/v1/users/me/messages') {
        return json({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] });
      }
      if (call.url.pathname === '/gmail/v1/users/me/messages/m1') {
        return json({
          id: 'm1',
          threadId: 't1',
          labelIds: ['UNREAD', 'IMPORTANT'],
          snippet: 'Please review',
          internalDate: '1763360000000',
          payload: { headers: headers({ From: 'Alex <alex@example.com>', Subject: 'Invoice' }) },
        });
      }
      return json({
        id: 'm2',
        threadId: 't2',
        labelIds: [],
        snippet: 'Lunch?',
        internalDate: '1763350000000',
        payload: { headers: headers({ From: 'Mina <mina@example.com>', Subject: 'Hi' }) },
      });
    });
    const mail = makeMail(fake);

    const results = await mail.search({
      text: 'invoice',
      unreadOnly: true,
      importantOnly: true,
      sinceHours: 24,
      limit: 10,
    });

    const listCall = fake.calls[0];
    const after = Math.floor((START.getTime() - 24 * 3_600_000) / 1000);
    expect(listCall?.url.pathname).toBe('/gmail/v1/users/me/messages');
    expect(listCall?.url.searchParams.get('q')).toBe(`invoice is:unread is:important after:${after}`);
    expect(listCall?.url.searchParams.get('maxResults')).toBe('10');
    expect(listCall?.headers.get('authorization')).toBe('Bearer mail-token');

    const metadataCall = fake.calls[1];
    expect(metadataCall?.url.pathname).toBe('/gmail/v1/users/me/messages/m1');
    expect(metadataCall?.url.searchParams.get('format')).toBe('metadata');
    expect(metadataCall?.url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject', 'Date']);

    expect(results).toEqual([
      {
        id: 'm1',
        threadId: 't1',
        from: 'Alex <alex@example.com>',
        subject: 'Invoice',
        snippet: 'Please review',
        receivedAt: new Date(1763360000000),
        unread: true,
        important: true,
        labels: ['UNREAD', 'IMPORTANT'],
      },
      {
        id: 'm2',
        threadId: 't2',
        from: 'Mina <mina@example.com>',
        subject: 'Hi',
        snippet: 'Lunch?',
        receivedAt: new Date(1763350000000),
        unread: false,
        important: false,
      },
    ]);
  });
});

describe('GoogleMail.read', () => {
  it('reads headers and decodes the plain-text body', async () => {
    const body = Buffer.from('Hello\n세계', 'utf8').toString('base64url');
    const fake = fakeFetch(() =>
      json({
        id: 'm1',
        threadId: 't1',
        labelIds: ['UNREAD'],
        snippet: 'Hello',
        internalDate: '1763360000000',
        payload: {
          mimeType: 'text/plain',
          headers: headers({
            From: 'Alex <alex@example.com>',
            Subject: '안녕',
            To: 'mina@example.com, alex@example.com',
            Cc: 'boss@example.com',
          }),
          body: { data: body },
        },
      }),
    );

    const message = await makeMail(fake).read('m1');

    expect(fake.calls[0]?.url.searchParams.get('format')).toBe('full');
    expect(message).toMatchObject({
      id: 'm1',
      threadId: 't1',
      from: 'Alex <alex@example.com>',
      subject: '안녕',
      to: ['mina@example.com', 'alex@example.com'],
      cc: ['boss@example.com'],
      body: 'Hello\n세계',
      unread: true,
      important: false,
    });
  });

  it('caps the body at 20000 characters', async () => {
    const long = '가'.repeat(25_000);
    const fake = fakeFetch(() =>
      json({
        id: 'm1',
        threadId: 't1',
        internalDate: '0',
        payload: { mimeType: 'text/plain', body: { data: Buffer.from(long, 'utf8').toString('base64url') } },
      }),
    );

    const message = await makeMail(fake).read('m1');
    expect(message.body).toHaveLength(20_000);
  });
});

describe('GoogleMail.draftReply', () => {
  it('builds a threaded reply and creates a draft', async () => {
    const fake = fakeFetch((call) => {
      if (call.method === 'POST') return json({ id: 'd1' });
      return json({
        id: 'm1',
        threadId: 't1',
        payload: {
          headers: headers({
            'Message-ID': '<message-1@example.com>',
            References: '<root@example.com>',
            Subject: '회의 시간',
            From: 'Alex <alex@example.com>',
          }),
        },
      });
    });

    const draft = await makeMail(fake).draftReply('m1', '답장 본문이에요.');

    expect(fake.calls[0]?.url.searchParams.getAll('metadataHeaders')).toEqual([
      'Message-ID',
      'References',
      'Subject',
      'From',
      'Reply-To',
    ]);
    const posted = JSON.parse(fake.calls[1]?.body ?? '{}');
    expect(fake.calls[1]?.url.pathname).toBe('/gmail/v1/users/me/drafts');
    expect(posted.message.threadId).toBe('t1');
    const raw = Buffer.from(posted.message.raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: Alex <alex@example.com>');
    expect(raw).toContain('In-Reply-To: <message-1@example.com>');
    expect(raw).toContain('References: <root@example.com> <message-1@example.com>');
    const encodedBody = raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '');
    expect(Buffer.from(encodedBody, 'base64').toString('utf8')).toBe('답장 본문이에요.');

    expect(draft).toEqual({
      draftId: 'd1',
      to: ['Alex <alex@example.com>'],
      cc: [],
      subject: 'Re: 회의 시간',
      body: '답장 본문이에요.',
    });
  });
});

describe('GoogleMail.getDraft', () => {
  it('reads a draft in full format', async () => {
    const fake = fakeFetch(() =>
      json({
        id: 'd1',
        message: {
          payload: {
            mimeType: 'text/plain',
            headers: headers({ To: 'alex@example.com', Cc: 'mina@example.com', Subject: 'Hello' }),
            body: { data: Buffer.from('초안 본문', 'utf8').toString('base64url') },
          },
        },
      }),
    );

    const draft = await makeMail(fake).getDraft('d1');

    expect(fake.calls[0]?.url.pathname).toBe('/gmail/v1/users/me/drafts/d1');
    expect(fake.calls[0]?.url.searchParams.get('format')).toBe('full');
    expect(draft).toEqual({
      draftId: 'd1',
      to: ['alex@example.com'],
      cc: ['mina@example.com'],
      subject: 'Hello',
      body: '초안 본문',
    });
  });
});

describe('GoogleMail.sendDraft', () => {
  it('sends the draft and returns the message id', async () => {
    const fake = fakeFetch(() => json({ id: 'sent-1' }));

    const result = await makeMail(fake).sendDraft('d1');

    expect(fake.calls[0]?.url.pathname).toBe('/gmail/v1/users/me/drafts/send');
    expect(JSON.parse(fake.calls[0]?.body ?? '{}')).toEqual({ id: 'd1' });
    expect(result).toEqual({ messageId: 'sent-1' });
  });
});
