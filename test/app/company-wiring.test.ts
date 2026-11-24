import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/build.js';
import { builtinPlugins } from '../../src/app/plugins.js';
import { starterTeams } from '../../src/cli/setup-optional.js';
import { parseConfig } from '../../src/core/config/load.js';
import { Contracts } from '../../src/core/contracts/index.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { parseCompanyConfig } from '../../src/skills/company/config.js';

const config = parseConfig({
  version: 1,
  assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
  owner: { discordUserId: '11111111111111111' },
  plugins: {
    'skill.company': { enabled: true, teams: starterTeams(undefined) },
    'skill.tuning': { enabled: true },
    // no real HTTP listener in a unit test: the port may be taken on a developer machine (retries for ~30s)
    'bridge.mobile': { enabled: false },
  },
});

describe('company mode wiring', () => {
  it('starter teams from setup are valid company config', () => {
    expect(parseCompanyConfig({ teams: starterTeams('example/app') }).teams.map((team) => team.kind)).toEqual([
      'general',
      'general',
      'dev',
    ]);
  });

  it('sets up with the real core services and exposes its backlog to self-tuning', async () => {
    const plugins = builtinPlugins(config).filter((plugin) => plugin.manifest.kind !== 'channel');
    const app = await buildApp({
      config,
      secrets: new MemorySecretStore(),
      log: silentLogger,
      plugins,
      storePath: ':memory:',
      run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    });
    await app.start();
    try {
      const backlog = await app.host.capability(Contracts.backlog)!.snapshot(new Date());
      expect(backlog).toMatchObject({ open: 0, openLimit: 6 });
      expect(app.tools.get('company.submit')).toBeDefined();
      expect(app.tools.get('company.profile')).toBeDefined();
      expect(app.tools.get('knowledge.doc_verify')).toBeDefined();
      const findings = await app.host.capability(Contracts.health)!.runAll(new Date());
      expect(findings.some((finding) => finding.id === 'company.backlog')).toBe(true);
      expect(await app.host.capability(Contracts.docs)!.get('company:team:ops')).toMatchObject({ title: '운영' });
    } finally {
      await app.stop('test');
    }
  });
});
