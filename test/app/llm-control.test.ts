import { describe, expect, it } from 'vitest';
import { AppLlmControl } from '../../src/app/llm-control.js';
import { parseConfig } from '../../src/core/config/load.js';
import { RoutingLlmGateway } from '../../src/core/llm/gateway.js';
import type { LlmProvider, UsageLedger } from '../../src/core/llm/types.js';
import { MemoryAuditLog, silentLogger } from '../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { MapKeyValueStore } from '../core/helpers.js';

const ledger: UsageLedger = { record: async () => undefined, spentUsd: async () => 0 };

function local(id: string, seen: string[]): LlmProvider {
  return {
    id,
    async complete(model, request) {
      seen.push(`${id}/${model}/${request.tier}`);
      return { text: 'ok', providerId: id, model, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  };
}

function setup(fetchStatus = 200) {
  const seen: string[] = [];
  const config = parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    channel: 'app',
    llm: {
      providers: [{ id: 'mac', kind: 'claude-cli' }],
      routes: [{ providerId: 'mac', model: 'cli', tiers: ['deep', 'standard', 'fast'], maxSensitivity: 'sensitive' }],
    },
  });
  const gateway = new RoutingLlmGateway({ providers: [local('mac', seen)], routes: config.llm.routes, budget: config.llm.budget, ledger, timeZone: 'Asia/Seoul', log: silentLogger });
  const secrets = new MemorySecretStore({});
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return new Response('{}', { status: fetchStatus });
  }) as unknown as typeof fetch;
  const kv = new MapKeyValueStore();
  const audit = new MemoryAuditLog();
  const control = new AppLlmControl({ config, secrets, gateway, kv, audit, now: () => new Date('2026-11-19T00:00:00Z'), fetch: fakeFetch });
  return { control, gateway, secrets, calls, seen, kv, audit };
}

describe('AI connections and tiers from the app (R7, R12)', () => {
  it('checks a key, keeps it only in the Keychain, routes to it at once, and forgets it on disconnect', async () => {
    const { control, gateway, secrets, calls, audit } = setup();
    await control.apply();
    const before = await control.providers();
    expect(before.find((p) => p.id === 'mac')).toMatchObject({ kind: 'subscription', connected: true, editable: false });
    expect(before.find((p) => p.id === 'deepseek')).toMatchObject({ kind: 'api_key', connected: false, status: 'off' });

    expect(await control.connect('deepseek', 'short')).toMatchObject({ ok: false });
    expect(await control.connect('deepseek', 'sk-deepseek-1234567890abc')).toMatchObject({ ok: true, status: 'ok' });
    expect(calls[0]).toMatchObject({ url: 'https://api.deepseek.com/v1/models', headers: { authorization: 'Bearer sk-deepseek-1234567890abc' } });
    expect(await secrets.get('llm.deepseek.api-key')).toBe('sk-deepseek-1234567890abc');
    const after = (await control.providers()).find((p) => p.id === 'deepseek');
    expect(after).toMatchObject({ connected: true, status: 'ok', keyHint: '…abc', models: ['deepseek-reasoner', 'deepseek-chat'] });
    expect(JSON.stringify(after)).not.toContain('1234567890');
    expect(JSON.stringify(audit.entries)).not.toContain('1234567890');
    expect(gateway.describe().routes.some((r) => r.providerId === 'deepseek' && r.maxSensitivity === 'masked')).toBe(true);

    expect(await control.disconnect('deepseek')).toBe(true);
    expect(await secrets.get('llm.deepseek.api-key')).toBeUndefined();
    expect(gateway.describe().activeProviders).toEqual(['mac']);
    expect(await control.disconnect('mac')).toBe(false);
  });

  it('refuses a rejected key without saving it', async () => {
    const { control, secrets } = setup(401);
    expect(await control.connect('openai', 'sk-openai-1234567890abc')).toMatchObject({ ok: false });
    expect(await secrets.get('llm.openai.api-key')).toBeUndefined();
  });

  it('orders models inside a tier and gives a purpose its own tier', async () => {
    const { control, gateway, seen } = setup();
    await control.apply();
    await control.connect('anthropic', 'sk-ant-1234567890abcdef');
    const deep = (await control.tiers()).find((row) => row.tier === 'deep');
    expect(deep?.models.map((m) => m.id)).toEqual(['mac/cli', 'anthropic/claude-opus-5-5']);
    expect(await control.rank('deep', ['anthropic/claude-opus-5-5'])).toBe(false);
    expect(await control.rank('deep', ['anthropic/claude-opus-5-5', 'mac/cli'])).toBe(true);
    expect(gateway.describe().routes.filter((r) => r.tiers.includes('deep')).map((r) => r.providerId)).toEqual(['anthropic', 'mac']);

    await control.setPurpose('bot.dev', 'fast');
    await gateway.complete({ purpose: 'bot.dev', tier: 'standard', sensitivity: 'public', messages: [] }).catch(() => undefined);
    await gateway.complete({ purpose: 'assistant.turn', tier: 'standard', sensitivity: 'public', messages: [] }).catch(() => undefined);
    expect(seen.at(-1)).toBe('mac/cli/standard');
    expect(seen).toContain('mac/cli/fast');
    await control.setPurpose('bot.dev', null);
    expect((await control.purposeTiers()).size).toBe(0);
  });
});
