import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { configureLlm } from '../../src/cli/setup-llm.js';
import type { CliConnectDeps } from '../../src/cli/setup-llm-cli.js';
import { connectCli } from '../../src/cli/setup-llm-cli.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';

function fake(state: { installed: boolean; signedIn: boolean; npm?: boolean }): CliConnectDeps & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    find: (command) => (command === 'npm' ? (state.npm === false ? undefined : '/bin/npm') : state.installed ? `/bin/${command}` : undefined),
    signedIn: async () => state.signedIn,
    attached: async (command, args) => {
      ran.push([command, ...args].join(' '));
      if (command === 'npm') state.installed = true;
      else state.signedIn = true;
      return 0;
    },
  };
}

describe('connectCli', () => {
  it('says ready when installed and signed in, without asking', async () => {
    const prompter = createScriptedPrompter([]);
    expect(await connectCli(prompter, fake({ installed: true, signedIn: true }), 'claude')).toBe('ready');
    expect(prompter.said.join('\n')).toContain('로그인돼 있어요');
  });

  it('installs, then signs in on this terminal', async () => {
    const deps = fake({ installed: false, signedIn: false });
    expect(await connectCli(createScriptedPrompter(['1', '1']), deps, 'claude')).toBe('ready');
    expect(deps.ran).toEqual(['npm install -g @anthropic-ai/claude-code', '/bin/claude auth login']);
  });

  it('codex signs in with codex login; later leaves it', async () => {
    const deps = fake({ installed: true, signedIn: false });
    expect(await connectCli(createScriptedPrompter(['1']), deps, 'codex')).toBe('ready');
    expect(deps.ran).toEqual(['/bin/codex login']);
    expect(await connectCli(createScriptedPrompter(['2']), fake({ installed: true, signedIn: false }), 'codex')).toBe('later');
  });
});

describe('configureLlm with connect', () => {
  it('goes back to the list when the owner picks another AI', async () => {
    const deps = fake({ installed: false, signedIn: false, npm: false });
    // 5 = claude-cli; not installed, npm missing → [다른 AI, 나중에]; 1 = 다른 AI; then 6 = codex-cli, installed? no → later
    const prompter = createScriptedPrompter(['5', '1', '6', '2']);
    const result = await configureLlm(prompter, new MemorySecretStore(), undefined, { connectCli: deps });
    expect(result.providers.map((provider) => provider.id)).toEqual(['codex-cli']);
  });
});
