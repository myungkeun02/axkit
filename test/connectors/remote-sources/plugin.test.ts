import { afterEach, describe, expect, it } from 'vitest';
import { agentSessionsConnector } from '../../../src/connectors/agent-sessions/plugin.js';
import { folderScanConnector } from '../../../src/connectors/local-files/scan-plugin.js';
import { exchangePairingCode } from '../../../src/connectors/remote-sources/pair.js';
import { remoteSourcesConnector } from '../../../src/connectors/remote-sources/plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { remoteTokenSecret } from '../../../src/core/remote/ids.js';
import { createTestContext } from '../../support/context.js';
import type { SourceFixture } from '../../support/source.js';
import { startSourceFixture } from '../../support/source.js';

describe('connector.remote-sources', () => {
  let fixture: SourceFixture | undefined;
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it('declares one Keychain token per paired Mac', () => {
    const plugin = remoteSourcesConnector({ remotes: [{ name: 'MacBook', url: 'http://127.0.0.1:1', host: 'x', addedAt: '' }] });
    expect(plugin.manifest.secrets).toEqual(['remote-source.macbook.token']);
  });

  it('folds the paired Mac into files.scan and sessions.agents, and finds files there by name', async () => {
    fixture = await startSourceFixture({
      run: async (cmd, args) => ({ code: 0, stdout: cmd === 'mdfind' ? `${args[1] ?? ''}/notes.md\n` : '', stderr: '', timedOut: false }),
    });
    const { token } = await exchangePairingCode(fixture.url, await fixture.code(), 'mac-mini');
    const { ctx, secrets, registry } = createTestContext();
    await secrets.set(remoteTokenSecret('MacBook'), token);
    await folderScanConnector({ home: fixture.sourceHome }).setup(ctx);
    await agentSessionsConnector({ home: fixture.sourceHome }).setup(ctx);
    await remoteSourcesConnector({ remotes: [{ name: 'MacBook', url: fixture.url, host: 'x', addedAt: '' }] }).setup(ctx);

    const walk = await ctx.use(Contracts.folderScan).open(['remote:MacBook']).walk();
    expect(walk.files.map((file) => file.path)).toContain('MacBook:~/Documents/notes.md');
    const sessions = await ctx.use(Contracts.agentSessions).list();
    expect(sessions.map((session) => session.cwd)).toEqual(['remote:MacBook:~/dev/app']);

    const tool = registry.get('files.find_remote');
    expect(tool).toBeDefined();
    const result = (await tool!.run({ query: 'notes', limit: 5 }, { log: ctx.log, signal: new AbortController().signal, call: { grounding: [] } })) as { found: { path: string }[] };
    expect(result.found.map((file) => file.path)).toEqual(['MacBook:~/Documents/notes.md']);
  });
});
