import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { App } from '../../../src/app/build.js';
import { buildApp } from '../../../src/app/build.js';
import { openPhoneAdmin, phoneStorePath } from '../../../src/app/phone.js';
import type { AppChannelOptions } from '../../../src/channels/app/plugin.js';
import { appChannel } from '../../../src/channels/app/plugin.js';
import type { AppEvent } from '../../../src/channels/app/protocol.js';
import { parseConfig } from '../../../src/core/config/load.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import type { Plugin } from '../../../src/core/plugin/types.js';
import type { LlmProvider } from '../../../src/core/llm/types.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import { mobileBridge } from '../../../src/mobile/plugin.js';
import { flush } from '../../core/helpers.js';

/** A real app (phone bridge on port 0 + app channel) for the push and file tests. */
export interface AppHarness {
  app: App;
  home: string;
  base: string;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  secrets?: Record<string, string>;
  channelConfig?: Record<string, unknown>;
  channel?: Partial<AppChannelOptions>;
  plugins?: Plugin[];
  /** A fake model, routed for every tier. */
  llm?: LlmProvider;
}

export async function startApp(options: HarnessOptions = {}): Promise<AppHarness> {
  const home = await mkdtemp(join(tmpdir(), 'axkit-app-'));
  const config = parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    channel: 'app',
    plugins: { 'bridge.mobile': { port: 0 }, ...(options.channelConfig ? { 'channel.app': options.channelConfig } : {}) },
    ...(options.llm !== undefined
      ? {
          llm: {
            providers: [{ id: options.llm.id, kind: 'claude-cli' }],
            routes: [{ providerId: options.llm.id, model: 'm', tiers: ['fast', 'standard', 'deep'], maxSensitivity: 'sensitive' }],
          },
        }
      : {}),
  });
  let listening = 0;
  const plugins: Plugin[] = [
    mobileBridge({ onListening: (port) => (listening = port) }),
    appChannel({ expiresMinutes: 30, filesDir: join(home, 'files', 'app'), ...options.channel }),
    ...(options.plugins ?? []),
  ];
  await mkdir(join(home, 'data'), { recursive: true });
  const app = await buildApp({
    config,
    secrets: new MemorySecretStore(options.secrets ?? {}),
    log: silentLogger,
    plugins,
    storePath: phoneStorePath(home),
    ...(options.llm !== undefined ? { llmProviders: [options.llm] } : {}),
  });
  await app.start();
  return {
    app,
    home,
    base: `http://127.0.0.1:${listening}`,
    stop: async () => {
      await app.stop('test');
      await rm(home, { recursive: true, force: true });
    },
  };
}

export async function pairApp(h: AppHarness): Promise<{ token: string; deviceId: string }> {
  const handle = openPhoneAdmin(h.home);
  try {
    const result = await handle.admin.pair({ name: '내 폰', platform: 'ios', client: 'app' });
    await handle.admin.attachFiles(result.pairing.nonce, [], `${h.base}|${result.token}`);
    const response = await fetch(`${h.base}/m/p/${result.pairing.nonce}/app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: result.pairing.code }),
    });
    const body = (await response.json()) as { ok: boolean; token: string; deviceId: string };
    expect(body.ok).toBe(true);
    return { token: body.token, deviceId: body.deviceId };
  } finally {
    await handle.close();
  }
}

export function api(h: AppHarness, token: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${h.base}/m/v1/app/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function events(h: AppHarness, token: string): Promise<AppEvent[]> {
  const body = (await (await api(h, token, 'events?after=0')).json()) as { events: AppEvent[] };
  return body.events;
}

export async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
}
