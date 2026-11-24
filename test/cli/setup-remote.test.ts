import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverOnThisComputer } from '../../src/app/discover-projects.js';
import { remoteSourcesFrom } from '../../src/app/remote-sources.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { listRemotes, removeRemote } from '../../src/cli/remote.js';
import { askOnboarding } from '../../src/cli/setup-onboarding.js';
import { workPlaceStep } from '../../src/cli/setup-remote.js';
import { readRemotes } from '../../src/connectors/remote-sources/store.js';
import { remoteTokenSecret } from '../../src/core/remote/ids.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import type { SourceFixture } from '../support/source.js';
import { startSourceFixture } from '../support/source.js';

const NOW = new Date('2026-11-23T09:00:00.000Z');

describe('setup: work files on another Mac', () => {
  let fixture: SourceFixture | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('pairs the other Mac, says what it found and lists its projects with the Mac name', async () => {
    fixture = await startSourceFixture();
    dir = await mkdtemp(join(tmpdir(), 'ax-setup-remote-'));
    const file = join(dir, 'remotes.json');
    const secrets = new MemorySecretStore();
    const code = await fixture.code();
    const prompter = createScriptedPrompter([
      '1', // 처음 알아보기: now
      '2', // 다른 맥
      '', // 준비되면 엔터
      fixture.url.replace('http://', ''),
      code,
      'MacBook',
      '', // 가져올 번호: the checked ones
      '', // 회사 이름 그대로
      '1', // 더 참고할 것: 대화 기록만
    ]);
    const entry = await askOnboarding({
      prompter,
      home: dir,
      dirExists: async () => false,
      driveConnected: false,
      now: () => NOW,
      workPlace: workPlaceStep({ secrets, file, now: () => NOW, thisMac: 'mac-mini' }),
      discover: async (folders) => await discoverOnThisComputer(folders, { home: dir!, remotes: remoteSourcesFrom(await readRemotes(file), secrets) }),
    });

    expect(prompter.remaining()).toBe(0);
    expect(entry['folders']).toEqual(['remote:MacBook']);
    expect(entry['projects']).toEqual(expect.arrayContaining([{ path: 'remote:MacBook:~/dev/app', name: 'app', company: 'acme', remote: 'github.com/acme/app' }]));
    expect(prompter.said.some((line) => line.includes('ax-kit source pair'))).toBe(true);
    expect(prompter.said).toContain('연결됐어요: MacBook · 공유 폴더 2개 · Claude Code·Codex 대화 1개');
    expect(await readRemotes(file)).toEqual([{ name: 'MacBook', url: fixture.url, host: 'Theos-MacBook-Pro', addedAt: NOW.toISOString() }]);
    expect(await secrets.has(remoteTokenSecret('MacBook'))).toBe(true);
    expect((await fixture.tokens.clients()).map((client) => client.name)).toEqual(['mac-mini']);

    const list = createScriptedPrompter([]);
    await listRemotes({ prompter: list, secrets, file });
    expect(list.said[0]).toContain('MacBook');
    expect(list.said[0]).toContain('연결됨 · 폴더 2개 · 대화 1개');
    await removeRemote({ prompter: list, secrets, file }, 'macbook');
    expect(await readRemotes(file)).toEqual([]);
    expect(await secrets.has(remoteTokenSecret('MacBook'))).toBe(false);
  });

  it('offers a retry after a wrong code and falls back to this Mac when skipped', async () => {
    fixture = await startSourceFixture();
    dir = await mkdtemp(join(tmpdir(), 'ax-setup-remote-'));
    const prompter = createScriptedPrompter(['3', '', fixture.url, 'WRONG-CODE', '2']);
    const place = await workPlaceStep({ secrets: new MemorySecretStore(), file: join(dir, 'remotes.json'), now: () => NOW })(prompter);
    expect(place).toEqual({ local: true, folders: [] });
    expect(prompter.said.some((line) => line.includes('코드가 맞지 않거나'))).toBe(true);
  });

  it('keeps this Mac only when the owner says so', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ax-setup-remote-'));
    const prompter = createScriptedPrompter(['1']);
    expect(await workPlaceStep({ secrets: new MemorySecretStore(), file: join(dir, 'remotes.json'), now: () => NOW })(prompter)).toEqual({ local: true, folders: [] });
  });
});
