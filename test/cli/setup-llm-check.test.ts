import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { configureLlm } from '../../src/cli/setup-llm.js';
import { checkProvider } from '../../src/cli/setup-llm-check.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';

const reply = (status: number, body: unknown = {}): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('setup checks the AI before saving it', () => {
  it('says plainly what is wrong: the key, the balance, a stopped or empty local model', async () => {
    const anthropic = { id: 'anthropic', kind: 'anthropic' as const, priceIn: 3, priceOut: 15 };
    expect(await checkProvider(anthropic, 'k', reply(200))).toEqual({ ok: true });
    expect(await checkProvider(anthropic, 'bad', reply(401))).toMatchObject({ ok: false, reason: expect.stringContaining('API 키가 맞지 않아요') });
    expect(await checkProvider(anthropic, 'k', reply(429))).toMatchObject({ ok: false, reason: expect.stringContaining('한도') });
    const ollama = { id: 'ollama', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:11434/v1', priceIn: 0, priceOut: 0 };
    const down: typeof fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await checkProvider(ollama, undefined, down, 'llama3.1')).toMatchObject({ ok: false, reason: expect.stringContaining('Ollama가 켜져 있지 않아요') });
    expect(await checkProvider(ollama, undefined, reply(200, { data: [{ id: 'qwen2' }] }), 'llama3.1')).toMatchObject({ ok: false, reason: expect.stringContaining('ollama pull llama3.1') });
    expect(await checkProvider(ollama, undefined, reply(200, { data: [{ id: 'llama3.1:latest' }] }), 'llama3.1')).toEqual({ ok: true });
  });

  it('a wrong key is asked again and never saved; the right one is', async () => {
    const secrets = new MemorySecretStore();
    const keys: string[] = [];
    const prompter = createScriptedPrompter(['1', 'wrong-key', '1', 'sk-right']);
    const result = await configureLlm(prompter, secrets, undefined, { checkProvider: async (_provider, key) => (keys.push(key ?? ''), key === 'sk-right' ? { ok: true } : { ok: false, reason: 'API 키가 맞지 않아요.' }) });
    expect(keys).toEqual(['wrong-key', 'sk-right']);
    expect(await secrets.get('llm.anthropic.api-key')).toBe('sk-right');
    expect(result.providers.length).toBeGreaterThan(0);
  });
});
