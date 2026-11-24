import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadReleaseApk } from './android-release.js';

const fakeFetch = (files: Record<string, Buffer | undefined>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const body = files[String(url).split('/').pop() ?? ''];
    return body === undefined ? new Response('no', { status: 404 }) : new Response(body);
  }) as typeof fetch;

describe('downloadReleaseApk', () => {
  it('keeps the released APK and its info next to each other', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apk-'));
    const apk = Buffer.from('apk-bytes');
    const info = Buffer.from(JSON.stringify({ versionCode: 53, size: apk.length }));
    const path = await downloadReleaseApk(join(dir, 'apk', 'ax-kit.apk'), fakeFetch({ 'ax-kit.apk': apk, 'ax-kit.json': info }), 'https://example.test');
    expect(await readFile(path, 'utf8')).toBe('apk-bytes');
    expect(JSON.parse(await readFile(join(dir, 'apk', 'ax-kit.json'), 'utf8'))).toMatchObject({ versionCode: 53 });
  });

  it('refuses an APK the info does not describe, and a missing release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apk-'));
    const info = Buffer.from(JSON.stringify({ size: 1 }));
    await expect(downloadReleaseApk(join(dir, 'a.apk'), fakeFetch({ 'ax-kit.apk': Buffer.from('xx'), 'ax-kit.json': info }), 'https://example.test')).rejects.toThrow('설명과 달라요');
    await expect(downloadReleaseApk(join(dir, 'a.apk'), fakeFetch({}), 'https://example.test')).rejects.toThrow('404');
  });
});
