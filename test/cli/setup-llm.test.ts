import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { LLM_PRESETS, configureLlm } from '../../src/cli/setup-llm.js';

function presetIndex(id: string): string {
  const index = LLM_PRESETS.findIndex((preset) => preset.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  return String(index + 1);
}

describe('configureLlm with subscription CLIs', () => {
  it('uses the claude CLI preset without asking for an API key', async () => {
    const prompter = createScriptedPrompter([presetIndex('claude-cli')]);
    const checked: string[] = [];
    const checkCommand = async (command: string): Promise<boolean> => {
      checked.push(command);
      return true;
    };

    const result = await configureLlm(prompter, new MemorySecretStore(), undefined, { checkCommand });

    expect(checked).toEqual(['claude']);
    expect(prompter.remaining()).toBe(0);
    expect(result.providers).toEqual([
      { id: 'claude-cli', kind: 'claude-cli', command: 'claude', priceIn: 0, priceOut: 0 },
    ]);
    expect(result.routes).toEqual([
      { providerId: 'claude-cli', model: 'opus', tiers: ['deep'], maxSensitivity: 'sensitive' },
      { providerId: 'claude-cli', model: 'sonnet', tiers: ['standard'], maxSensitivity: 'sensitive' },
      { providerId: 'claude-cli', model: 'haiku', tiers: ['fast'], maxSensitivity: 'sensitive' },
    ]);

    const said = prompter.said.join('\n');
    expect(said).toContain('구독');
    expect(said).toContain('약관');
    expect(said).toContain('로그인');
    expect(said).not.toContain('찾지 못했어요');
  });

  it('warns when the CLI command is not installed', async () => {
    const prompter = createScriptedPrompter([presetIndex('claude-cli')]);
    const checkCommand = vi.fn(async () => false);

    await configureLlm(prompter, new MemorySecretStore(), undefined, { checkCommand });

    expect(checkCommand).toHaveBeenCalledWith('claude');
    expect(prompter.said.join('\n')).toContain("'claude' 명령을 찾지 못했어요");
  });

  it('configures the codex CLI preset for every tier', async () => {
    const prompter = createScriptedPrompter([presetIndex('codex-cli')]);
    const checkCommand = vi.fn(async () => true);

    const result = await configureLlm(prompter, new MemorySecretStore(), undefined, { checkCommand });

    expect(checkCommand).toHaveBeenCalledWith('codex');
    expect(result.providers).toEqual([
      { id: 'codex-cli', kind: 'codex-cli', command: 'codex', priceIn: 0, priceOut: 0 },
    ]);
    expect(result.routes).toEqual([
      {
        providerId: 'codex-cli',
        model: 'gpt-5-codex',
        tiers: ['fast', 'standard', 'deep'],
        maxSensitivity: 'sensitive',
      },
    ]);
  });

  it('shows the notice in English for an English setup', async () => {
    const existing = parseConfig({
      version: 1,
      assistant: { name: 'Mina', language: 'en', timezone: 'Asia/Seoul' },
      owner: { discordUserId: '12345678901234567' },
      llm: {
        providers: [{ id: 'codex-cli', kind: 'codex-cli' }],
        routes: [{ providerId: 'codex-cli', model: 'gpt-5-codex', tiers: ['fast'], maxSensitivity: 'sensitive' }],
      },
    });
    const prompter = createScriptedPrompter([presetIndex('codex-cli')]);

    await configureLlm(prompter, new MemorySecretStore(), existing, { checkCommand: async () => true });

    expect(prompter.said.join('\n')).toContain('Usage limits');
  });
});
