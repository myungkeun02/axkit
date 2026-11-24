import { describe, expect, it, vi } from 'vitest';
import { PluginHost } from '../../src/core/plugin/host.js';
import { defineCapability } from '../../src/core/plugin/types.js';
import type { Plugin, PluginInstance } from '../../src/core/plugin/types.js';
import { parseConfig } from '../../src/core/config/load.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { TimerScheduler } from '../../src/core/scheduler/scheduler.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import type { ConfigInput } from '../../src/core/config/schema.js';
import type { LlmGateway } from '../../src/core/llm/types.js';
import { namespaceFactory } from './helpers.js';
import { RegistryToolbox } from '../../src/core/tools/toolbox.js';
import { systemClock } from '../../src/core/scheduler/clock.js';

const baseConfig: ConfigInput = {
  version: 1,
  assistant: { name: 'Jarvis', language: 'en', timezone: 'Asia/Seoul' },
  owner: { discordUserId: '12345678901234567' },
};

const llm: LlmGateway = {
  complete: async () => {
    throw new Error('unused');
  },
};

function makeHost(config: ConfigInput, secrets = new MemorySecretStore()): PluginHost {
  const tools = new InMemoryToolRegistry();
  return new PluginHost({
    config: parseConfig(config),
    secrets,
    bus: new InMemoryEventBus(silentLogger),
    scheduler: new TimerScheduler({ timeZone: 'Asia/Seoul', log: silentLogger }),
    llm,
    log: silentLogger,
    tools,
    toolbox: new RegistryToolbox(tools, { execute: async () => ({ status: 'failed', error: 'unused' }) }),
    clock: systemClock,
    kv: namespaceFactory(),
  });
}

describe('PluginHost', () => {
  it('sets up plugins after their dependencies regardless of insertion order', async () => {
    const host = makeHost(baseConfig);
    const order: string[] = [];
    const cap = defineCapability<{ answer: number }>('demo.answer');

    const dependent: Plugin = {
      manifest: { id: 'skill.b', kind: 'skill', title: 'B', needs: [cap] },
      setup: (ctx) => {
        order.push('setup:b');
        expect(ctx.use(cap).answer).toBe(42);
        ctx.registerHandler({ id: 'low', priority: 1, handle: async () => 'pass' });
      },
    };
    const provider: Plugin = {
      manifest: { id: 'skill.a', kind: 'skill', title: 'A' },
      setup: (ctx) => {
        order.push('setup:a');
        ctx.provide(cap, { answer: 42 });
        ctx.registerHandler({ id: 'high', priority: 10, handle: async () => 'handled' });
      },
    };

    host.add(dependent);
    host.add(provider);
    await host.setupAll();

    expect(order).toEqual(['setup:a', 'setup:b']);
    expect(host.capability(cap)).toEqual({ answer: 42 });
    expect(host.handlers().map((handler) => handler.id)).toEqual(['high', 'low']);
    expect(host.plugins().map((plugin) => plugin.id)).toEqual(['skill.b', 'skill.a']);
  });

  it('reports every plugin still missing a capability', async () => {
    const host = makeHost(baseConfig);
    const missingCap = defineCapability<unknown>('demo.missing');
    const setup = vi.fn();
    const plugin: Plugin = {
      manifest: { id: 'skill.c', kind: 'skill', title: 'C', needs: [missingCap] },
      setup,
    };
    host.add(plugin);

    await expect(host.setupAll()).rejects.toThrow(/skill\.c: missing demo\.missing/);
    expect(setup).not.toHaveBeenCalled();
  });

  it('skips disabled plugins', async () => {
    const host = makeHost({ ...baseConfig, plugins: { 'skill.skip': { enabled: false } } });
    const setup = vi.fn();
    host.add({ manifest: { id: 'skill.skip', kind: 'skill', title: 'Skipped' }, setup });

    await host.setupAll();
    expect(setup).not.toHaveBeenCalled();
    expect(host.isEnabled('skill.skip')).toBe(false);
    expect(host.plugins()[0]).toMatchObject({ id: 'skill.skip', enabled: false, started: false });
  });

  it('scopes secrets to the manifest allow-list', async () => {
    const secrets = new MemorySecretStore({ 'demo.allowed': 'value', 'demo.other': 'nope' });
    const host = makeHost(baseConfig, secrets);

    host.add({
      manifest: { id: 'skill.secrets', kind: 'skill', title: 'Secrets', secrets: ['demo.allowed'] },
      setup: async (ctx) => {
        expect(await ctx.secrets.get('demo.allowed')).toBe('value');
        await expect(ctx.secrets.get('demo.other')).rejects.toThrow(/skill\.secrets.*demo\.other/);
      },
    });

    await expect(host.setupAll()).resolves.toBeUndefined();
  });

  it('starts in setup order and stops in reverse with error isolation', async () => {
    const events: string[] = [];
    const host = makeHost(baseConfig);
    const instance = (id: string): PluginInstance => ({
      start: async () => {
        events.push(`start:${id}`);
      },
      stop: async () => {
        events.push(`stop:${id}`);
      },
    });

    host.add({ manifest: { id: 'skill.a', kind: 'skill', title: 'A' }, setup: () => instance('a') });
    host.add({ manifest: { id: 'skill.b', kind: 'skill', title: 'B' }, setup: () => instance('b') });
    host.add({
      manifest: { id: 'skill.bad', kind: 'skill', title: 'Bad' },
      setup: () => ({
        stop: async () => {
          throw new Error('stop failed');
        },
      }),
    });

    await host.setupAll();
    await host.startAll();
    await expect(host.stopAll()).resolves.toBeUndefined();

    expect(events).toEqual(['start:a', 'start:b', 'stop:b', 'stop:a']);
    expect(host.plugins().every((plugin) => !plugin.started)).toBe(true);
  });

  it('rejects duplicate plugin ids and duplicate capabilities', async () => {
    const host = makeHost(baseConfig);
    const plugin: Plugin = { manifest: { id: 'skill.a', kind: 'skill', title: 'A' }, setup: () => undefined };
    host.add(plugin);
    expect(() => host.add(plugin)).toThrow(/Duplicate plugin id/);

    const cap = defineCapability<string>('demo.dup');
    expect(() => {
      host.add({
        manifest: { id: 'skill.first', kind: 'skill', title: 'First' },
        setup: (ctx) => ctx.provide(cap, 'one'),
      });
      host.add({
        manifest: { id: 'skill.second', kind: 'skill', title: 'Second' },
        setup: (ctx) => ctx.provide(cap, 'two'),
      });
    }).not.toThrow();
    await expect(host.setupAll()).rejects.toThrow(/Capability already provided: demo\.dup/);
  });
});
