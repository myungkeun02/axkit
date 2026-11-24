import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceFixture } from '../support/source.js';
import { startSourceFixture } from '../support/source.js';

async function post(fixture: SourceFixture, route: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> | unknown[] }> {
  const response = await fetch(`${fixture.url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function pair(fixture: SourceFixture): Promise<string> {
  const result = await post(fixture, '/v1/pair', { code: await fixture.code(), name: 'mac-mini' });
  expect(result.status).toBe(200);
  return (result.body as { token: string }).token;
}

describe('ax-kit source serve', () => {
  let fixture: SourceFixture | undefined;
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it('needs a paired token for everything but pairing, and a code works once', async () => {
    fixture = await startSourceFixture();
    expect((await post(fixture, '/v1/info', {})).status).toBe(401);
    expect((await post(fixture, '/v1/info', {}, 'not-a-token')).status).toBe(401);

    const code = await fixture.code();
    expect((await post(fixture, '/v1/pair', { code: 'WRONG-CODE', name: 'x' })).status).toBe(401);
    const ok = await post(fixture, '/v1/pair', { code: code.toLowerCase(), name: 'mac-mini' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ host: 'Theos-MacBook-Pro' });
    expect((await post(fixture, '/v1/pair', { code, name: 'again' })).status).toBe(401);

    const token = (ok.body as { token: string }).token;
    const info = await post(fixture, '/v1/info', {}, token);
    expect(info.body).toEqual({ host: 'Theos-MacBook-Pro', folders: ['~/Documents', '~/dev'], sessions: true });
    expect((await fixture.tokens.clients()).map((client) => client.name)).toEqual(['mac-mini']);
    expect(await fixture.tokens.revoke('mac-mini')).toBe(1);
    expect((await post(fixture, '/v1/info', {}, token)).status).toBe(401);
  });

  it('drops a code after five wrong tries', async () => {
    fixture = await startSourceFixture();
    const code = await fixture.code();
    for (let index = 0; index < 5; index += 1) await post(fixture, '/v1/pair', { code: 'AAAA-AAAA', name: 'x' });
    expect((await post(fixture, '/v1/pair', { code, name: 'x' })).status).toBe(401);
  });

  it('walks only the shared folders and leaves sensitive names out', async () => {
    fixture = await startSourceFixture();
    const token = await pair(fixture);
    const walk = (await post(fixture, '/v1/walk', { all: true }, token)).body as { files: { id: string }[]; repos: { id: string }[] };
    const ids = walk.files.map((file) => file.id);
    expect(ids).toContain('~/Documents/notes.md');
    expect(ids.some((id) => id.includes('passwords') || id.includes('.env') || id.includes('Private'))).toBe(false);
    expect(walk.repos.map((repo) => repo.id)).toEqual(['~/dev/app']);

    const outside = (await post(fixture, '/v1/walk', { folders: ['~/Private', '/etc'] }, token)).body as { files: unknown[] };
    expect(outside.files).toEqual([]);
  });

  it('reads an excerpt inside the folders and refuses escapes and sensitive files', async () => {
    fixture = await startSourceFixture();
    const token = await pair(fixture);
    expect((await post(fixture, '/v1/excerpt', { id: '~/Documents/notes.md', maxBytes: 1000 }, token)).body).toEqual({ text: '# 회의 메모\n신제품 출시 계획' });
    await symlink(join(fixture.home, 'Private', 'diary.md'), join(fixture.home, 'Documents', 'link.md'));
    for (const id of ['~/Private/diary.md', '~/Documents/../Private/diary.md', '/etc/hosts', '~/Documents/link.md', '~/Documents/passwords.txt', '~/Documents/.env', 'relative.md']) {
      const result = await post(fixture, '/v1/excerpt', { id, maxBytes: 1000 }, token);
      expect(result.status, id).toBe(403);
      expect(JSON.stringify(result.body)).not.toContain('private');
      expect(JSON.stringify(result.body)).not.toContain('hunter2');
    }
    expect((await post(fixture, '/v1/excerpt', { id: '~/Private/diary.md', maxBytes: 1000 }, token)).status).toBe(403);
    expect((await post(fixture, '/v1/repo', { id: '~/Private' }, token)).status).toBe(403);
    expect((await post(fixture, '/v1/locate', { path: '~/Private' }, token)).body).toEqual({});
    expect((await post(fixture, '/v1/locate', { path: '~/dev/app' }, token)).body).toEqual({ root: { root: '~/dev/app', display: '~/dev/app', name: 'app', remote: 'github.com/acme/app' } });
  });

  it('limits requests per token', async () => {
    fixture = await startSourceFixture({ perMinute: 3 });
    const token = await pair(fixture);
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) statuses.push((await post(fixture, '/v1/info', {}, token)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('finds files by name with Spotlight only inside the shared folders', async () => {
    const calls: string[][] = [];
    fixture = await startSourceFixture({
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        const root = args[1] ?? '';
        const home = root.replace(/\/(Documents|dev)$/, '');
        return { code: 0, stdout: [`${root}/notes.md`, `${root}/passwords.txt`, `${home}/Private/diary.md`, `${root}/missing.md`].join('\n'), stderr: '', timedOut: false };
      },
    });
    const token = await pair(fixture);
    const found = (await post(fixture, '/v1/find', { query: '-notes', limit: 10 }, token)).body as { path: string }[];
    expect(found.map((file) => file.path)).toEqual(['~/Documents/notes.md']);
    expect(calls.every((call) => call[0] === 'mdfind' && call[1] === '-onlyin' && call[3] === '-name' && call[4] === 'notes')).toBe(true);
  });

  it('shares no sessions when the owner said no', async () => {
    fixture = await startSourceFixture({ sessions: false });
    const token = await pair(fixture);
    expect((await post(fixture, '/v1/sessions', {}, token)).body).toEqual([]);
    expect((await post(fixture, '/v1/transcript', { tool: 'claude', id: 'abc', maxChars: 100 }, token)).body).toEqual({});
  });
});
