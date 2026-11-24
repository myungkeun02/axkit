import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BotAvatars } from '../../../src/channels/app/avatars.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { api, pairApp, startApp } from './harness.js';

interface JobRow { id: string; enabled: boolean; toggleable?: boolean; detail?: string }
async function jobs(h: Awaited<ReturnType<typeof startApp>>, token: string): Promise<JobRow[]> {
  const body = (await (await api(h, token, 'views/jobs')).json()) as { data: { groups: { jobs: JobRow[] }[] } };
  return body.data.groups.flatMap((group) => group.jobs);
}

describe('owner settings from the app (R6, R7, R12, R13)', () => {
  it('turns a recurring job off and on again', async () => {
    const h = await startApp();
    try {
      const { token } = await pairApp(h);
      const id = (await jobs(h, token))[0]?.id ?? '';
      expect(id).not.toBe('');
      expect((await api(h, token, 'views/jobs/toggle', { id, enabled: false })).status).toBe(200);
      expect((await jobs(h, token)).find((job) => job.id === id)).toMatchObject({ enabled: false, detail: expect.stringContaining('앱에서 껐어요') });
      expect((await api(h, token, 'views/jobs/toggle', { id, enabled: true })).status).toBe(200);
      expect((await jobs(h, token)).find((job) => job.id === id)?.enabled).toBe(true);
      expect((await api(h, token, 'views/jobs/toggle', { id: 'nope', enabled: false })).status).toBe(400);
    } finally {
      await h.stop();
    }
  });

  it('lists AIs and tiers, takes tier choices, and refuses a malformed key before any network call', async () => {
    const h = await startApp({ llm: { id: 'fake', complete: async () => ({ text: '{}', providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }) } });
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[] };
      expect(caps.features).toEqual(expect.arrayContaining(['ai-connect', 'model-tiers']));
      const providers = (await (await api(h, token, 'views/providers')).json()) as { data: { providers: { id: string; editable: boolean }[] } };
      expect(providers.data.providers.map((p) => p.id)).toEqual(expect.arrayContaining(['fake', 'anthropic', 'openai', 'deepseek']));
      const bad = await api(h, token, 'providers/deepseek/key', { apiKey: 'x y' });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { message: string }).message).toContain('키');
      expect((await api(h, token, 'providers/fake/disconnect', {})).status).toBe(400);

      const tiers = (await (await api(h, token, 'views/modeltiers')).json()) as { data: { tiers: { id: string; models: { id: string }[] }[]; purposes: { id: string; tier: string; chosen: boolean }[] } };
      expect(tiers.data.tiers.map((t) => t.id)).toEqual(['S', 'A', 'B', 'C']);
      expect(tiers.data.tiers[0]?.models.map((m) => m.id)).toEqual(['fake/m']);
      expect((await api(h, token, 'views/modeltiers/rank', { tier: 'S', order: ['other/x'] })).status).toBe(400);
      expect((await api(h, token, 'views/modeltiers/purpose', { id: 'assistant', tier: 'S' })).status).toBe(200);
      const again = (await (await api(h, token, 'views/modeltiers')).json()) as typeof tiers;
      expect(again.data.purposes.find((p) => p.id === 'assistant')).toMatchObject({ tier: 'S', chosen: true });
    } finally {
      await h.stop();
    }
  });

  it('shows a bot picture once it exists and serves it with the device token', async () => {
    const h = await startApp();
    try {
      const { token } = await pairApp(h);
      await h.app.host.capability(Contracts.bots)?.upsert({ id: 'dev', name: '개발 봇', role: '앱 코드', kind: 'dev', origin: 'owner' });
      const botOf = async () => ((await (await api(h, token, 'views/bots')).json()) as { data: { groups: { bots: { id: string; avatar?: string }[] }[] } }).data.groups.flatMap((g) => g.bots)[0];
      expect((await botOf())?.avatar).toBeUndefined();
      await mkdir(join(h.home, 'files', 'avatars'), { recursive: true });
      await writeFile(join(h.home, 'files', 'avatars', 'dev.png'), 'PNG');
      expect((await botOf())?.avatar).toBe('files/avatar-dev.png');
      const file = await fetch(`${h.base}/m/v1/app/files/avatar-dev.png`, { headers: { authorization: `Bearer ${token}` } });
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('image/png');
    } finally {
      await h.stop();
    }
  });

  it('draws a missing picture only with an image key, sending just the name and role', async () => {
    const dir = join(await import('node:os').then((os) => os.tmpdir()), `axkit-av-${Date.now()}`);
    const bodies: string[] = [];
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('PNG').toString('base64') }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const bots = { list: async () => [{ id: 'dev', name: '개발 봇', role: '앱 코드를 고쳐요', kind: 'dev', status: 'idle', origin: 'owner', createdAt: '' }] };
    const ctxOf = (secrets: Record<string, string>) => ({ secrets: new MemorySecretStore(secrets), kv: new MapKeyValueStore(), log: silentLogger }) as unknown as PluginContext;
    expect(await new BotAvatars(dir, ctxOf({}), fakeFetch).fill(bots as never)).toBe(0);
    const avatars = new BotAvatars(dir, ctxOf({ 'llm.openai.api-key': 'sk-img' }), fakeFetch);
    expect(await avatars.fill(bots as never)).toBe(1);
    expect(await avatars.has('dev')).toBe(true);
    expect(await avatars.fill(bots as never)).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('앱 코드를 고쳐요');
  });
});
