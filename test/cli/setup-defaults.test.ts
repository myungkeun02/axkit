import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { BASIC_ON, setupBasics } from '../../src/cli/setup-defaults.js';
import { GITHUB_TOKEN_SECRET } from '../../src/cli/setup-optional.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';

describe('setupBasics', () => {
  it('turns the everyday features on without asking, installs, and uses the gh login once the owner says yes', async () => {
    const secrets = new MemorySecretStore();
    let browser = 0;
    let transcribe = 0;
    // the gh login is used only after a yes; then the other-app screens (none picked)
    const prompter = createScriptedPrompter(['1', 'none']);
    const result = await setupBasics({
      prompter,
      secrets,
      ensureBrowser: async () => (browser++, true),
      installTranscriber: async () => (transcribe++, true),
      github: { token: async () => 'gho_test', login: async () => 1 },
    });
    for (const id of BASIC_ON) expect(result.plugins[id]?.['enabled']).toBe(true);
    expect(result.plugins['skill.todo']).toEqual({ source: 'apple-reminders' });
    expect(result.plugins['connector.kakao-desktop']?.['enabled']).toBe(false);
    expect(result).toMatchObject({ browser: true, transcribe: true, github: 'connected' });
    expect([browser, transcribe]).toEqual([1, 1]);
    expect(await secrets.get(GITHUB_TOKEN_SECRET)).toBe('gho_test');
    expect(prompter.remaining()).toBe(0);
  });

  it('does not ask about GitHub on a Mac with no code, and keeps a basic the owner turned off', async () => {
    const prompter = createScriptedPrompter(['none']);
    const result = await setupBasics({ prompter, secrets: new MemorySecretStore(), hasCode: async () => false, github: { token: async () => 'gho_test', login: async () => 1 }, existing: { plugins: { 'skill.company': { enabled: false } } } as never });
    expect(result.github).toBe('later');
    expect(result.plugins['skill.company']?.['enabled']).toBe(false);
    expect(prompter.remaining()).toBe(0);
  });

  it('asks to sign in to GitHub when gh is not signed in, and keeps it for later on no', async () => {
    const secrets = new MemorySecretStore();
    let signedIn = false;
    const result = await setupBasics({
      prompter: createScriptedPrompter(['1', '1']),
      secrets,
      github: { token: async () => (signedIn ? 'gho_new' : undefined), login: async () => ((signedIn = true), 0) },
    });
    expect(result.github).toBe('connected');
    expect(result.plugins['connector.kakao-desktop']?.['enabled']).toBe(true);
    const later = await setupBasics({ prompter: createScriptedPrompter(['2', '']), secrets: new MemorySecretStore() });
    expect(later.github).toBe('later');
  });
});
