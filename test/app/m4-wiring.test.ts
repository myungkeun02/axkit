import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/build.js';
import { builtinPlugins } from '../../src/app/plugins.js';
import { parseConfig } from '../../src/core/config/load.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { Contracts } from '../../src/core/contracts/index.js';

describe('M4 wiring', () => {
  it('sets up every optional plugin with the defaults, and the risky tools always ask', async () => {
    const config = parseConfig({
      version: 1,
      assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
      owner: { discordUserId: '11111111111111111' },
      plugins: {
        'connector.google-calendar': { enabled: true },
        'connector.kakao-desktop': { enabled: true },
        'connector.discord-app': { enabled: true },
        'connector.browser': { enabled: true },
        'connector.macos-ocr': { enabled: true },
        'skill.dev-assist': { enabled: true, repos: [] },
        'skill.tuning': { enabled: true },
      },
    });
    const app = await buildApp({
      config,
      secrets: new MemorySecretStore(),
      log: silentLogger,
      plugins: builtinPlugins(config, { home: '/tmp/ax-kit-test-home' }),
      storePath: ':memory:',
    });
    await app.host.setupAll();

    const names = app.tools.list().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(app.host.capability(Contracts.ocr)).toBeDefined();
    expect(app.host.capability(Contracts.browser)).toBeDefined();
    expect(app.host.capability(Contracts.peopleWrite)).toBeDefined();
    expect(app.host.capability(Contracts.noticeMute)).toBeDefined();
    const effects = new Map(app.tools.list().map((tool) => [tool.name, tool.effects]));
    expect(effects.get('kakao.send')).toContain('send');
    expect(effects.get('browser.task')).toContain('send');
    expect(effects.get('dev.open_pr')).toContain('send');
    expect(effects.get('dev.discard')).toContain('delete');
    expect(names).toEqual(expect.arrayContaining(['chat.pending', 'receipts.read_file', 'tuning.list', 'dev.start']));
    expect(names.some((name) => name.includes('merge'))).toBe(false);
    await app.stop('test');
  });
});
