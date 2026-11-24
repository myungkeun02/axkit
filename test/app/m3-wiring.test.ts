import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/build.js';
import { builtinPlugins } from '../../src/app/plugins.js';
import { parseConfig } from '../../src/core/config/load.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { Contracts } from '../../src/core/contracts/index.js';

describe('M3 wiring', () => {
  it('sets up every built-in plugin together without capability, tool or job clashes', async () => {
    const config = parseConfig({
      version: 1,
      assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
      owner: { discordUserId: '11111111111111111' },
      plugins: {
        'connector.google-calendar': { enabled: true },
        'connector.gmail': { enabled: true },
        'connector.google-drive': { enabled: true, folderIds: [] },
        'connector.local-files': { enabled: true, folders: [] },
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
    expect(names).toEqual(
      expect.arrayContaining([
        'spending.list',
        'spending.summary',
        'expenses.candidates',
        'expenses.draft_claim_mail',
        'watch.add',
        'docs.search',
        'trips.list',
        'files.search',
      ]),
    );
    expect(app.host.capability(Contracts.spendRead)).toBeDefined();
    expect(app.host.capability(Contracts.webPage)).toBeDefined();
    expect(app.host.capability(Contracts.filesLocal)).toBeDefined();
    expect(app.host.capability(Contracts.filesDrive)).toBeDefined();
    expect(app.host.capability(Contracts.mailCompose)).toBeDefined();
    expect(app.host.capability(Contracts.mailAttachments)).toBeDefined();
    const effects = new Map(app.tools.list().map((tool) => [tool.name, tool.effects]));
    for (const name of ['watch.remove', 'expenses.remove_rule', 'trips.remove_segment', 'memory.forget']) {
      expect(effects.get(name)).toContain('delete');
    }
    expect(effects.get('mail.send_draft')).toContain('send');
    expect(effects.get('expenses.draft_claim_mail')).toEqual(['write']);
    await app.stop('test');
  });
});
