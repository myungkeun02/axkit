import { describe, expect, it } from 'vitest';
import { GmailAttachments } from '../../../src/connectors/google/gmail-attachments.js';
import { fakeFetch, json, requestWithToken } from './helpers.js';

const BASE = '/gmail/v1/users/me/messages/m1';

function make(fake: ReturnType<typeof fakeFetch>) {
  return new GmailAttachments({ request: requestWithToken(fake, 'attachment-token') });
}

describe('GmailAttachments.list', () => {
  it('walks nested payload parts and returns parts with a filename and attachment id', async () => {
    const fake = fakeFetch(() =>
      json({
        id: 'm1',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                { mimeType: 'text/plain', body: { data: 'aGVsbG8' } },
                {
                  filename: 'invoice.pdf',
                  mimeType: 'application/pdf',
                  body: { attachmentId: 'a1', size: 1234 },
                },
              ],
            },
            { filename: 'photo.PNG', mimeType: 'image/png', body: { attachmentId: 'a2', size: 10 } },
            { filename: '', mimeType: 'text/plain', body: { attachmentId: 'a3', size: 1 } },
            { filename: 'no-id.txt', mimeType: 'text/plain', body: { size: 5 } },
          ],
        },
      }),
    );

    const listed = await make(fake).list('m1');

    expect(fake.calls[0]?.url.pathname).toBe(BASE);
    expect(fake.calls[0]?.url.searchParams.get('format')).toBe('full');
    expect(fake.calls[0]?.headers.get('authorization')).toBe('Bearer attachment-token');
    expect(listed).toEqual([
      { id: 'a1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1234 },
      { id: 'a2', filename: 'photo.PNG', mimeType: 'image/png', size: 10 },
    ]);
  });

  it('returns an empty list when the message has no payload', async () => {
    const fake = fakeFetch(() => json({ id: 'm1' }));
    await expect(make(fake).list('m1')).resolves.toEqual([]);
  });
});

describe('GmailAttachments.download', () => {
  it('decodes base64url attachment data to bytes', async () => {
    const data = Buffer.from('hello world', 'utf8');
    const fake = fakeFetch((call) =>
      call.url.pathname.endsWith('/attachments/a1')
        ? json({ data: data.toString('base64url'), size: data.length })
        : json({
            id: 'm1',
            payload: {
              filename: 'a.txt',
              mimeType: 'text/plain',
              body: { attachmentId: 'a1', size: data.length },
            },
          }),
    );

    const bytes = await make(fake).download('m1', 'a1', 100);

    expect(fake.calls[1]?.url.pathname).toBe(`${BASE}/attachments/a1`);
    expect(fake.calls[1]?.method).toBe('GET');
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello world');
  });

  it('refuses before downloading when the listed size is too large', async () => {
    const fake = fakeFetch(() =>
      json({ payload: { filename: 'big.pdf', body: { attachmentId: 'a1', size: 500 } } }),
    );

    await expect(make(fake).download('m1', 'a1', 100)).rejects.toThrow(/larger than 100/);
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses when the downloaded bytes are larger than the cap', async () => {
    const fake = fakeFetch((call) =>
      call.url.pathname.endsWith('/attachments/a1')
        ? json({ data: Buffer.alloc(200, 1).toString('base64url') })
        : json({ payload: { filename: 'small.pdf', body: { attachmentId: 'a1', size: 5 } } }),
    );

    await expect(make(fake).download('m1', 'a1', 100)).rejects.toThrow(/larger than 100/);
    expect(fake.calls).toHaveLength(2);
  });

  it('refuses an empty attachment response', async () => {
    const fake = fakeFetch((call) =>
      call.url.pathname.endsWith('/attachments/a1')
        ? json({})
        : json({ payload: { filename: 'a.txt', body: { attachmentId: 'a1', size: 5 } } }),
    );

    await expect(make(fake).download('m1', 'a1', 100)).rejects.toThrow(/no data/);
  });
});
