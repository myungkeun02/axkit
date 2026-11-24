import { describe, expect, it } from 'vitest';
import {
  buildReplyMime,
  decodeBase64Url,
  encodeBase64Url,
  extractPlainText,
  replySubject,
} from '../../../src/connectors/google/mime.js';

function headerLine(mime: string, name: string): string {
  return mime.split('\r\n').find((line) => line.startsWith(`${name}: `)) ?? '';
}

function decodeHeaderValue(value: string): string {
  const encodedWord = /^=\?UTF-8\?B\?(.+)\?=$/.exec(value);
  return encodedWord === null ? value : Buffer.from(encodedWord[1] ?? '', 'base64').toString('utf8');
}

function decodeBody(mime: string): string {
  const separator = mime.indexOf('\r\n\r\n');
  const body = mime.slice(separator + 4).replace(/\r\n/g, '');
  return Buffer.from(body, 'base64').toString('utf8');
}

function part(mimeType: string, text: string) {
  return { mimeType, body: { data: Buffer.from(text, 'utf8').toString('base64url') } };
}

describe('base64url helpers', () => {
  it('round-trips Korean text', () => {
    const text = '안녕하세요. 메일 본문이에요.';
    expect(decodeBase64Url(encodeBase64Url(text))).toBe(text);
  });
});

describe('buildReplyMime', () => {
  it('encodes a Korean subject and body and adds a reply prefix', () => {
    const mime = buildReplyMime({
      to: ['alex@example.com'],
      subject: '회의 시간',
      body: '내일 오후에 뵐게요.',
      inReplyTo: '<message-1@example.com>',
      references: ['<root@example.com>', '<message-1@example.com>'],
    });

    const subject = headerLine(mime, 'Subject');
    expect(subject).toMatch(/^Subject: =\?UTF-8\?B\?/);
    expect(decodeHeaderValue(subject.slice('Subject: '.length))).toBe('Re: 회의 시간');
    expect(decodeBody(mime)).toBe('내일 오후에 뵐게요.');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(headerLine(mime, 'In-Reply-To')).toBe('In-Reply-To: <message-1@example.com>');
    expect(headerLine(mime, 'References')).toBe('References: <root@example.com> <message-1@example.com>');
  });

  it('does not add a second reply prefix', () => {
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    const mime = buildReplyMime({ to: ['alex@example.com'], subject: 'RE: Hello', body: 'ok' });
    expect(headerLine(mime, 'Subject')).toBe('Subject: RE: Hello');
  });

  it('strips CR/LF from every header value', () => {
    const mime = buildReplyMime({
      to: ['alex@example.com\r\nBcc: evil@example.com'],
      cc: ['mina@example.com\nBcc: evil@example.com'],
      subject: 'Hello\r\nBcc: evil@example.com',
      inReplyTo: '<message-1@example.com>\r\nX-Evil: 1',
      references: ['<root@example.com>\r\nBcc: evil@example.com'],
      body: 'ok',
    });

    const lines = mime.split('\r\n');
    expect(lines.some((line) => /^Bcc:/i.test(line))).toBe(false);
    expect(lines.some((line) => /^X-Evil:/i.test(line))).toBe(false);
    expect(headerLine(mime, 'Subject')).toBe('Subject: Re: Hello Bcc: evil@example.com');
    expect(mime).not.toContain('\r\nBcc:');
    expect(mime).not.toContain('\nX-Evil:');
  });
});

describe('extractPlainText', () => {
  it('prefers text/plain when both alternatives exist', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [part('text/html', '<p>HTML</p>'), part('text/plain', '안녕하세요\n본문이에요')],
    };
    expect(extractPlainText(payload)).toBe('안녕하세요\n본문이에요');
  });

  it('strips tags and decodes entities from HTML', () => {
    const payload = part('text/html', '<div>Hello<br>World</div><p>Fish &amp; Chips</p>');
    expect(extractPlainText(payload)).toBe('Hello\nWorld\nFish & Chips');
  });

  it('returns an empty string when there is no body', () => {
    expect(extractPlainText({ mimeType: 'multipart/alternative', parts: [] })).toBe('');
  });
});

describe('reply with attachments', () => {
  it('builds multipart/mixed with the text first and a UTF-8 file name', async () => {
    const { buildReplyMime, attachmentNames } = await import('../../../src/connectors/google/mime.js');
    const mime = buildReplyMime({
      to: ['a@example.com'],
      subject: '자료',
      body: '첨부드립니다.',
      attachments: [{ filename: '회사소개서.pdf', mimeType: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }],
    });
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="axkit-[0-9a-f]+"/);
    expect(mime).toContain("filename*=UTF-8''%ED%9A%8C%EC%82%AC%EC%86%8C%EA%B0%9C%EC%84%9C.pdf");
    expect(mime).toContain(Buffer.from('첨부드립니다.', 'utf8').toString('base64'));
    expect(mime).toContain('JVBERg==');
    expect(mime.trimEnd()).toMatch(/--axkit-[0-9a-f]+--$/);
    expect(attachmentNames({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain' }, { mimeType: 'application/pdf', filename: '회사소개서.pdf' }] })).toEqual(['회사소개서.pdf']);
  });
});
