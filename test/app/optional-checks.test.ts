import { describe, expect, it } from 'vitest';
import { optionalChecks } from '../../src/app/optional-checks.js';
import { parseConfig } from '../../src/core/config/load.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import type { ProcessRunner } from '../../src/core/process/types.js';
import type { AxReader } from '../../src/connectors/screen-chat/index.js';

function config(plugins: Record<string, Record<string, unknown>>) {
  return parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    owner: { discordUserId: '11111111111111111' },
    plugins,
  });
}

const run: ProcessRunner = async (cmd) => ({ code: cmd === 'swiftc' ? 0 : 1, stdout: 'Swift 6', stderr: '', timedOut: false });

describe('optionalChecks', () => {
  it('checks nothing when no optional plugin is on', async () => {
    const checks = await optionalChecks({ config: config({}), home: '/h', secrets: new MemorySecretStore(), run });
    expect(checks).toEqual([]);
  });

  it('checks permission and apps without ever reading the chat screen', async () => {
    let dumps = 0;
    const reader: AxReader = {
      trusted: async () => false,
      dump: async () => {
        dumps += 1;
        throw new Error('must not read');
      },
    };
    const checks = await optionalChecks({
      config: config({ 'connector.kakao-desktop': { enabled: true }, 'connector.discord-app': { enabled: true } }),
      home: '/h',
      secrets: new MemorySecretStore(),
      run,
      reader,
      exists: async (path) => path.includes('KakaoTalk'),
    });
    expect(checks.map((check) => [check.id, check.ok])).toEqual([
      ['screen.accessibility', false],
      ['screen.kakao-app', true],
      ['screen.discord-app', false],
    ]);
    expect(checks[0]?.fix).toContain('Accessibility');
    expect(dumps).toBe(0);
  });

  it('reports the GitHub token by name only and checks the clone folder', async () => {
    const secrets = new MemorySecretStore();
    await secrets.set('github.token', 'github_pat_secret');
    const checks = await optionalChecks({
      config: config({
        'skill.dev-assist': { enabled: true, repos: [{ slug: 'example/app', path: '/code/app' }] },
        'connector.macos-ocr': { enabled: true },
      }),
      home: '/h',
      secrets,
      run,
      exists: async (path) => path === '/code/app/.git',
    });
    expect(checks.map((check) => [check.id, check.ok])).toEqual([
      ['ocr.swiftc', true],
      ['dev.github-token', true],
      ['dev.repo', true],
    ]);
    expect(JSON.stringify(checks)).not.toContain('github_pat_secret');
  });
});
