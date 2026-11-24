import { describe, expect, it } from 'vitest';
import { GmailOrganizer } from '../../../src/connectors/google/gmail-organize.js';
import { MultiOrganizer } from '../../../src/connectors/google/multi-mail.js';
import { gmailConnector } from '../../../src/connectors/google/plugin.js';
import { Contracts, MailPermissionError } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';
import { fakeFetch, json, requestWithToken } from './helpers.js';
import type { FetchCall } from './helpers.js';

const LABELS = {
  labels: [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'TRASH', name: 'TRASH', type: 'system' },
    { id: 'Label_7', name: '거래처', type: 'user' },
  ],
};

const SCOPE_ERROR = {
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
  },
};

function organizer(handler: (call: FetchCall) => Response) {
  const fake = fakeFetch(handler);
  return { fake, organizer: new GmailOrganizer({ request: requestWithToken(fake) }) };
}

function posted(call: FetchCall | undefined): unknown {
  return JSON.parse(call?.body ?? '{}');
}

describe('GmailOrganizer', () => {
  it('lists labels with their kind', async () => {
    const { organizer: gmail } = organizer(() => json(LABELS));
    expect(await gmail.labels()).toContainEqual({ id: 'Label_7', name: '거래처', system: false });
    expect(await gmail.labels()).toContainEqual({ id: 'INBOX', name: 'INBOX', system: true });
  });

  it('archives by removing INBOX in one batchModify, never trash', async () => {
    const { fake, organizer: gmail } = organizer(() => new Response(null, { status: 204 }));
    await gmail.archive(['m1', 'm2', 'm1']);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.url.pathname).toBe('/gmail/v1/users/me/messages/batchModify');
    expect(posted(fake.calls[0])).toEqual({ ids: ['m1', 'm2'], removeLabelIds: ['INBOX'] });
  });

  it('resolves label names case-insensitively and refuses trash', async () => {
    const { fake, organizer: gmail } = organizer((call) =>
      call.url.pathname.endsWith('/labels') ? json(LABELS) : new Response(null, { status: 204 }),
    );
    await gmail.addLabels(['m1'], ['거래처', 'unread']);
    expect(posted(fake.calls[1])).toEqual({ ids: ['m1'], addLabelIds: ['Label_7', 'UNREAD'] });
    await gmail.removeLabels(['m1'], ['INBOX']);
    expect(posted(fake.calls[3])).toEqual({ ids: ['m1'], removeLabelIds: ['INBOX'] });

    await expect(gmail.addLabels(['m1'], ['TRASH'])).rejects.toThrow(/cannot be changed/);
    await expect(gmail.addLabels(['m1'], ['없는 라벨'])).rejects.toThrow(/not found/);
    expect(fake.calls.filter((call) => call.url.pathname.endsWith('batchModify'))).toHaveLength(2);
  });

  it('refuses more than 50 mails at once', async () => {
    const { fake, organizer: gmail } = organizer(() => new Response(null, { status: 204 }));
    const ids = Array.from({ length: 51 }, (_, index) => `m${index}`);
    await expect(gmail.archive(ids)).rejects.toThrow(/At most 50/);
    expect(fake.calls).toHaveLength(0);
  });

  it('creates a missing label and reuses an existing one', async () => {
    const { fake, organizer: gmail } = organizer((call) =>
      call.method === 'POST' ? json({ id: 'Label_9', name: '정리함', type: 'user' }) : json(LABELS),
    );
    expect(await gmail.createLabel('거래처')).toEqual({ id: 'Label_7', name: '거래처', system: false });
    expect(fake.calls.some((call) => call.method === 'POST')).toBe(false);

    expect(await gmail.createLabel('정리함')).toEqual({ id: 'Label_9', name: '정리함', system: false });
    const create = fake.calls.find((call) => call.method === 'POST');
    expect(create?.url.pathname).toBe('/gmail/v1/users/me/labels');
    expect(posted(create)).toMatchObject({ name: '정리함' });
  });

  it('peeks at mails and leaves out ones that are gone', async () => {
    const { organizer: gmail } = organizer((call) =>
      call.url.pathname.endsWith('/m2')
        ? json({ error: { code: 404, message: 'Not Found' } }, 404)
        : json({
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
            payload: { headers: [{ name: 'From', value: 'Shop <ad@shop.example>' }, { name: 'Subject', value: '세일' }] },
          }),
    );
    const found = await gmail.peek(['m1', 'm2']);
    expect(found.map((mail) => [mail.id, mail.from, mail.subject])).toEqual([['m1', 'Shop <ad@shop.example>', '세일']]);
    expect(found[0]?.labels).toContain('CATEGORY_PROMOTIONS');
  });

  it('turns a missing gmail.modify scope into MailPermissionError', async () => {
    const { organizer: gmail } = organizer(() => json(SCOPE_ERROR, 403));
    await expect(gmail.archive(['m1'])).rejects.toBeInstanceOf(MailPermissionError);
    await expect(gmail.labels()).rejects.toBeInstanceOf(MailPermissionError);
  });

  it('keeps other 403s as plain API errors', async () => {
    const { organizer: gmail } = organizer(() => json({ error: { code: 403, message: 'Daily limit exceeded' } }, 403));
    const failure = await gmail.archive(['m1']).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(MailPermissionError);
    expect(String(failure)).toContain('Daily limit exceeded');
  });
});

describe('gmailConnector organize', () => {
  it('provides mail.organize only when Gmail 정리 was granted', async () => {
    const without = createTestContext();
    await gmailConnector().setup(without.ctx);
    expect(without.ctx.tryUse(Contracts.mailOrganize)).toBeUndefined();

    const granted = createTestContext({ config: { organize: true } });
    await gmailConnector().setup(granted.ctx);
    expect(granted.ctx.tryUse(Contracts.mailOrganize)).toBeInstanceOf(MultiOrganizer);
  });
});
