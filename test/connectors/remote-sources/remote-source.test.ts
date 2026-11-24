import { afterEach, describe, expect, it } from 'vitest';
import { discoverOnThisComputer } from '../../../src/app/discover-projects.js';
import { remoteSourcesFrom } from '../../../src/app/remote-sources.js';
import { RemoteSourceError, normalizeSourceUrl } from '../../../src/connectors/remote-sources/http.js';
import { exchangePairingCode } from '../../../src/connectors/remote-sources/pair.js';
import { discoverProjects } from '../../../src/skills/onboarding/projects.js';
import { composeFolderScanner, composeSessionReader } from '../../../src/core/remote/compose.js';
import { parseRemote, remoteDisplay, remoteTokenSecret } from '../../../src/core/remote/ids.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import type { FolderScanner } from '../../../src/core/contracts/scan.js';
import type { SourceFixture } from '../../support/source.js';
import { startSourceFixture } from '../../support/source.js';

async function pairedSource(fixture: SourceFixture) {
  const paired = await exchangePairingCode(fixture.url, await fixture.code(), 'mac-mini');
  const secrets = new MemorySecretStore();
  await secrets.set(remoteTokenSecret('MacBook'), paired.token);
  const [source] = remoteSourcesFrom([{ name: 'MacBook', url: fixture.url, host: paired.host, addedAt: '2026-11-23T00:00:00.000Z' }], secrets);
  return { source: source!, paired };
}

describe('remote sources', () => {
  let fixture: SourceFixture | undefined;
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it('namespaces ids and citations', () => {
    expect(parseRemote('remote:MacBook:~/a')).toEqual({ name: 'MacBook', path: '~/a' });
    expect(parseRemote('remote:MacBook')).toEqual({ name: 'MacBook' });
    expect(parseRemote('remote:Mac Book:~/a')).toBeUndefined();
    expect(parseRemote('remote:MacBook:a')).toBeUndefined();
    expect(parseRemote('/Users/me/remote:x')).toBeUndefined();
    expect(remoteDisplay('remote:MacBook:~/dev/app')).toBe('MacBook:~/dev/app');
    expect(normalizeSourceUrl('100.64.0.2:7787')).toBe('http://100.64.0.2:7787');
    expect(normalizeSourceUrl('http://u:p@host:1')).toBeUndefined();
    expect(normalizeSourceUrl('ftp://host')).toBeUndefined();
  });

  it('pairs with a code once and refuses a wrong one', async () => {
    fixture = await startSourceFixture();
    await expect(exchangePairingCode(fixture.url, 'ZZZZ-ZZZZ', 'mac-mini')).rejects.toMatchObject({ reason: 'unauthorized' });
    const code = await fixture.code();
    const paired = await exchangePairingCode(fixture.url, code, 'mac-mini');
    expect(paired.host).toBe('Theos-MacBook-Pro');
    expect(paired.token.length).toBeGreaterThan(30);
    await expect(exchangePairingCode(fixture.url, code, 'mac-mini')).rejects.toBeInstanceOf(RemoteSourceError);
  });

  it('scans, reads and locates on the other Mac through the composite scanner', async () => {
    fixture = await startSourceFixture();
    const { source } = await pairedSource(fixture);
    const localScanner: FolderScanner = { open: () => ({ walk: async () => ({ files: [], repos: [], truncated: false }), excerpt: async () => 'local', repo: async () => ({ commits: [], languages: [] }) }) };
    const scanner = composeFolderScanner(localScanner, () => [source], silentLogger);
    const scan = scanner.open(['~/Documents', 'remote:MacBook']);
    const walk = await scan.walk();
    const note = walk.files.find((file) => file.name === 'notes.md');
    expect(note).toMatchObject({ id: 'remote:MacBook:~/Documents/notes.md', path: 'MacBook:~/Documents/notes.md' });
    expect(walk.files.some((file) => file.name === 'passwords.txt')).toBe(false);
    expect(walk.repos).toEqual([expect.objectContaining({ id: 'remote:MacBook:~/dev/app', path: 'MacBook:~/dev/app' })]);
    expect(await scan.excerpt(note!.id, 100)).toContain('회의 메모');
    expect(await scan.excerpt('/Users/me/a.md', 100)).toBe('local');
    await expect(scan.excerpt('remote:MacBook:~/Private/diary.md', 100)).rejects.toMatchObject({ reason: 'refused' });
    await expect(scan.excerpt('remote:Other:~/a.md', 100)).rejects.toThrow();
    expect(await scanner.locate?.('remote:MacBook:~/dev/app')).toEqual({ root: 'remote:MacBook:~/dev/app', display: 'MacBook:~/dev/app', name: 'app', remote: 'github.com/acme/app' });

    // Only one folder on the other Mac.
    const narrow = await scanner.open(['remote:MacBook:~/dev']).walk();
    expect(narrow.files.every((file) => file.id.startsWith('remote:MacBook:~/dev/'))).toBe(true);
    expect(await source.find('notes', 5)).toEqual([]);
    expect(await source.info()).toEqual({ host: 'Theos-MacBook-Pro', folders: ['~/Documents', '~/dev'], sessions: true });
  });

  it('lists and reads sessions on the other Mac next to local ones', async () => {
    fixture = await startSourceFixture();
    const { source } = await pairedSource(fixture);
    const reader = composeSessionReader({ list: async () => [], transcript: async () => 'local' }, () => [source], silentLogger);
    const sessions = await reader.list();
    expect(sessions).toEqual([expect.objectContaining({ tool: 'claude', id: 'remote:MacBook:/s1', cwd: 'remote:MacBook:~/dev/app', turns: 1 })]);
    expect(await reader.transcript(sessions[0]!, 1000)).toContain('로그인 화면 고쳐줘');
  });

  it('skips a Mac that does not answer', async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(remoteTokenSecret('Gone'), 'x'.repeat(40));
    const [gone] = remoteSourcesFrom([{ name: 'Gone', url: 'http://127.0.0.1:1', host: 'gone', addedAt: '' }], secrets);
    const localScanner: FolderScanner = { open: () => ({ walk: async () => ({ files: [], repos: [], truncated: false }), excerpt: async () => '', repo: async () => ({ commits: [], languages: [] }) }) };
    expect(await composeFolderScanner(localScanner, () => [gone!], silentLogger).open(['remote:Gone']).walk()).toEqual({ files: [], repos: [], truncated: false });
    expect(await composeSessionReader({ list: async () => [], transcript: async () => undefined }, () => [gone!], silentLogger).list()).toEqual([]);
  });

  it('discovers projects on this Mac and the other Mac together', async () => {
    fixture = await startSourceFixture();
    const { source } = await pairedSource(fixture);
    const site = { id: '/Users/me/dev/site', path: '~/dev/site', name: 'site', modifiedAt: '2026-11-01T00:00:00.000Z' };
    const localScanner: FolderScanner = {
      open: (folders) => ({ walk: async () => ({ files: [], repos: folders.includes('/Users/me/dev') ? [site] : [], truncated: false }), excerpt: async () => '', repo: async () => ({ commits: [], languages: [] }) }),
      locate: async (path) => (path === site.id ? { root: site.id, display: site.path, name: 'site', remote: 'github.com/me/site' } : undefined),
    };
    const scanner = composeFolderScanner(localScanner, () => [source], silentLogger);
    const reader = composeSessionReader({ list: async () => [], transcript: async () => undefined }, () => [source], silentLogger);
    const walk = await scanner.open(['/Users/me/dev', 'remote:MacBook']).walk();
    const candidates = await discoverProjects({ repos: walk.repos, files: walk.files, sessions: await reader.list(), locate: async (path) => await scanner.locate?.(path), home: '/Users/me', personal: '개인' });
    const byDisplay = new Map(candidates.map((candidate) => [candidate.display, candidate]));
    expect(byDisplay.get('~/dev/site')).toMatchObject({ path: '/Users/me/dev/site', company: 'me', inFolders: true });
    expect(byDisplay.get('MacBook:~/dev/app')).toMatchObject({ path: 'remote:MacBook:~/dev/app', name: 'app', company: 'acme', claude: 1, inFolders: true });
    expect(byDisplay.get('MacBook:~/Documents/Brand')).toMatchObject({ path: 'remote:MacBook:~/Documents/Brand', docs: 6, company: '개인' });

    // The setup-time path (no server running yet) finds the same remote projects.
    const setupTime = await discoverOnThisComputer(['remote:MacBook'], { home: fixture.sourceHome, remotes: [source] });
    expect(setupTime.map((candidate) => candidate.display)).toEqual(expect.arrayContaining(['MacBook:~/dev/app', 'MacBook:~/Documents/Brand']));
  });
});
