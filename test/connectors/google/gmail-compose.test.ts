import { describe, expect, it } from 'vitest';
import { GmailComposer } from '../../../src/connectors/google/gmail-compose.js';
import { buildNewMime } from '../../../src/connectors/google/mime.js';
import { fakeFetch, json, requestWithToken } from './helpers.js';

function headerLine(mime: string, name: string): string {
  return mime.split('\r\n').find((line) => line.startsWith(`${name}: `)) ?? '';
}

function decodeHeaderValue(value: string): string {
  const encoded = /^=\?UTF-8\?B\?(.+)\?=$/.exec(value);
  return encoded === null ? value : Buffer.from(encoded[1] ?? '', 'base64').toString('utf8');
}

function decodeBody(mime: string): string {
  const separator = mime.indexOf('\r\n\r\n');
  return Buffer.from(mime.slice(separator + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('buildNewMime', () => {
  it('builds a UTF-8 message with encoded subject and base64 body', () => {
    const mime = buildNewMime({
      to: ['alex@example.com'],
      cc: ['mina@example.com'],
      subject: '회의 일정',
      body: '내일 오후에 뵐게요.',
    });

    expect(headerLine(mime, 'To')).toBe('To: alex@example.com');
    expect(headerLine(mime, 'Cc')).toBe('Cc: mina@example.com');
    const subject = headerLine(mime, 'Subject').slice('Subject: '.length);
    expect(decodeHeaderValue(subject)).toBe('회의 일정');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(decodeBody(mime)).toBe('내일 오후에 뵐게요.');
    expect(mime.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('rejects CR or LF in recipients and subject', () => {
    expect(() =>
      buildNewMime({ to: ['alex@example.com\r\nBcc: evil@example.com'], subject: 'Hi', body: 'ok' }),
    ).toThrow(/CR or LF/);
    expect(() =>
      buildNewMime({ to: ['alex@example.com'], cc: ['mina@example.com\nBcc: evil@example.com'], subject: 'Hi', body: 'ok' }),
    ).toThrow(/CR or LF/);
    expect(() => buildNewMime({ to: ['alex@example.com'], subject: 'Hi\nBcc: evil@example.com', body: 'ok' })).toThrow(
      /CR or LF/,
    );
  });
});

describe('GmailComposer.draftNew', () => {
  it('creates a new draft without a thread id and returns the inputs', async () => {
    const fake = fakeFetch(() => json({ id: 'd1' }));
    const composer = new GmailComposer({ request: requestWithToken(fake, 'compose-token') });

    const draft = await composer.draftNew({
      to: ['alex@example.com'],
      cc: ['mina@example.com'],
      subject: '회의 일정',
      body: '내일 오후에 뵐게요.',
    });

    expect(fake.calls[0]?.url.pathname).toBe('/gmail/v1/users/me/drafts');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.headers.get('authorization')).toBe('Bearer compose-token');
    const posted = JSON.parse(fake.calls[0]?.body ?? '{}') as {
      message: { raw: string; threadId?: string };
    };
    expect(posted.message.threadId).toBeUndefined();
    const raw = Buffer.from(posted.message.raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: alex@example.com');
    expect(raw).toContain('Cc: mina@example.com');
    expect(decodeBody(raw)).toBe('내일 오후에 뵐게요.');

    expect(draft).toEqual({
      draftId: 'd1',
      to: ['alex@example.com'],
      cc: ['mina@example.com'],
      subject: '회의 일정',
      body: '내일 오후에 뵐게요.',
    });
  });

  it('defaults cc to an empty list', async () => {
    const fake = fakeFetch(() => json({ id: 'd2' }));

    const draft = await new GmailComposer({ request: requestWithToken(fake) }).draftNew({
      to: ['alex@example.com'],
      subject: 'Hello',
      body: 'ok',
    });

    expect(draft.cc).toEqual([]);
    expect(JSON.parse(fake.calls[0]?.body ?? '{}')).toEqual({ message: { raw: expect.any(String) } });
  });

  it('fails when Gmail does not return a draft id', async () => {
    const fake = fakeFetch(() => json({}));

    await expect(
      new GmailComposer({ request: requestWithToken(fake) }).draftNew({
        to: ['alex@example.com'],
        subject: 'Hello',
        body: 'ok',
      }),
    ).rejects.toThrow(/did not return/);
  });
});
