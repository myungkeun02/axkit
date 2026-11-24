import { describe, expect, it } from 'vitest';
import { readerWith, fakeLookup, page, redirect } from './helpers.js';

describe('WebPageReader', () => {
  it('reads an HTML page into text with its title and status', async () => {
    const { reader, clock } = readerWith(() =>
      page('<html><head><title>예시 상점</title></head><body><h1>무선 이어폰</h1><p>판매가 12,900원</p></body></html>'),
    );

    const result = await reader.read('https://shop.example.com/item');

    expect(result).toEqual({
      url: 'https://shop.example.com/item',
      status: 200,
      title: '예시 상점',
      text: '예시 상점\n무선 이어폰\n판매가 12,900원',
      fetchedAt: clock.now(),
    });
  });

  it('sends the generic user agent and a manual redirect mode', async () => {
    const { reader, calls } = readerWith(() => page('ok', 200, 'text/plain'));
    await reader.read('https://example.com/');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('user-agent')).toBe('Mozilla/5.0 (compatible; ax-kit/0.1; personal assistant)');
    expect(calls[0]?.init?.redirect).toBe('manual');
  });

  it('refuses a private IP without fetching', async () => {
    const { reader, calls } = readerWith(() => page('should not load'));
    await expect(reader.read('http://127.0.0.1:8080/')).rejects.toThrow('not allowed');
    expect(calls).toHaveLength(0);
  });

  it('refuses a host that resolves to a private address', async () => {
    const { reader, calls } = readerWith(() => page('nope'), fakeLookup(['10.0.0.5']));
    await expect(reader.read('https://example.com/')).rejects.toThrow('not allowed');
    expect(calls).toHaveLength(0);
  });

  it('refuses a redirect to a private address', async () => {
    const { reader, calls } = readerWith(() => redirect('http://127.0.0.1/secret'));
    await expect(reader.read('https://example.com/start')).rejects.toThrow('not allowed');
    expect(calls).toHaveLength(1);
  });

  it('follows up to three relative redirects', async () => {
    const { reader, calls } = readerWith((url) => {
      const step = Number(url.pathname.slice(1));
      if (step < 3) return redirect(`/${step + 1}`);
      return page('arrived', 200, 'text/plain');
    });

    const result = await reader.read('https://example.com/0');

    expect(result.url).toBe('https://example.com/3');
    expect(result.text).toBe('arrived');
    expect(calls).toHaveLength(4);
  });

  it('stops after three redirects', async () => {
    const { reader, calls } = readerWith(() => redirect('/again'));
    await expect(reader.read('https://example.com/0')).rejects.toThrow('Too many redirects');
    expect(calls).toHaveLength(4);
  });

  it('refuses an unsupported content type without echoing the URL', async () => {
    const { reader } = readerWith(() => page('a,b', 200, 'text/csv'));
    try {
      await reader.read('https://example.com/data?key=secret-value');
      expect.fail('expected a refusal');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('지원하지 않는 형식');
      expect(message).not.toContain('secret-value');
    }
  });

  it('caps the body at 2 MB', async () => {
    const { reader } = readerWith(() => page('a'.repeat(3 * 1024 * 1024), 200, 'text/plain'));
    const result = await reader.read('https://example.com/big');
    expect(result.text.length).toBe(2 * 1024 * 1024);
  });

  it('returns JSON and plain text unchanged', async () => {
    const json = '{"name":"예시","price":12900}';
    const { reader } = readerWith(() => page(json, 200, 'application/json'));
    const result = await reader.read('https://example.com/data.json');
    expect(result.text).toBe(json);
    expect(result.title).toBeUndefined();
  });

  it('returns non-2xx pages with their status', async () => {
    const { reader } = readerWith(() => page('gone', 404, 'text/plain'));
    const result = await reader.read('https://example.com/gone');
    expect(result.status).toBe(404);
    expect(result.text).toBe('gone');
  });

  it('refuses an invalid URL', async () => {
    const { reader } = readerWith(() => page('ok'));
    await expect(reader.read('not a url')).rejects.toThrow('Invalid address');
  });

  it('refuses a redirect without a Location header', async () => {
    const { reader } = readerWith(() => new Response(null, { status: 302 }));
    await expect(reader.read('https://example.com/')).rejects.toThrow('redirect without a target');
  });
});
