import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app/build.js';
import { openPhoneAdmin, phoneStorePath } from '../../../src/app/phone.js';
import { appChannel } from '../../../src/channels/app/plugin.js';
import { parseConfig } from '../../../src/core/config/load.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import { mobileBridge } from '../../../src/mobile/plugin.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function start() {
  const home = await mkdtemp(join(tmpdir(), 'axkit-views-'));
  homes.push(home);
  await mkdir(join(home, 'data'), { recursive: true });
  let port = 0;
  const app = await buildApp({
    config: parseConfig({
      version: 1,
      assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
      channel: 'app',
      plugins: { 'bridge.mobile': { port: 0 } },
    }),
    secrets: new MemorySecretStore({}),
    log: silentLogger,
    plugins: [mobileBridge({ onListening: (p) => (port = p) }), appChannel({ expiresMinutes: 30 })],
    storePath: phoneStorePath(home),
  });
  await app.start();
  const base = `http://127.0.0.1:${port}`;
  const handle = openPhoneAdmin(home);
  const paired = await handle.admin.pair({ name: '맥', platform: 'desktop', client: 'app' });
  await handle.admin.attachFiles(paired.pairing.nonce, [], `${base}|${paired.token}`);
  await handle.close();
  const exchange = await fetch(`${base}/m/p/${paired.pairing.nonce}/app`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: paired.pairing.code }),
  });
  const { token } = (await exchange.json()) as { token: string };
  const call = async (path: string, auth = `Bearer ${token}`) => {
    const response = await fetch(`${base}/m/v1/app/${path}`, { headers: { authorization: auth } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads loose JSON
    return { status: response.status, type: response.headers.get('content-type'), body: (await response.json()) as Record<string, any> };
  };
  return { app, call };
}

describe('app views over HTTP', () => {
  it('lists jobs and models, adds daily usage and oldestSeq, and answers a bad token with JSON', async () => {
    const { app, call } = await start();
    try {
      const caps = await call('capabilities');
      const names = caps.body['views'].map((view: { name: string }) => view.name);
      expect(names).toEqual(expect.arrayContaining(['today', 'jobs', 'models', 'usage']));

      const jobs = (await call('views/jobs')).body['data'];
      const ids = jobs.groups[0].jobs.map((job: { id: string }) => job.id);
      expect(ids).toEqual(expect.arrayContaining(['core.retention', 'core.pause-expiry']));
      expect(jobs.groups[0].jobs.find((job: { id: string }) => job.id === 'core.retention').name).toBe('오래된 기록 정리');

      const models = (await call('views/models')).body['data'];
      expect(models.tiers.map((tier: { id: string }) => tier.id)).toEqual(['deep', 'standard', 'fast', 'cheap']);
      expect(models.actual).toMatchObject({ byTier: [], byPurpose: [] });

      const usage = (await call('views/usage?period=day')).body['data'];
      expect(usage.daily.length).toBeGreaterThan(0);
      expect(usage.daily[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/);

      const events = await call('events?after=0');
      expect(events.body).toMatchObject({ ok: true, lastSeq: 0, oldestSeq: 0 });

      const denied = await call('status', 'Bearer wrong');
      expect(denied.status).toBe(401);
      expect(denied.type).toContain('application/json');
      expect(denied.body).toEqual({ ok: false });
    } finally {
      await app.stop('test');
    }
  });
});
