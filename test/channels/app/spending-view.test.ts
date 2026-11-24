import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app/build.js';
import { openPhoneAdmin, phoneStorePath } from '../../../src/app/phone.js';
import { appChannel } from '../../../src/channels/app/plugin.js';
import { spendingLedgerView } from '../../../src/channels/app/views/spending.js';
import { parseConfig } from '../../../src/core/config/load.js';
import { ViewInputError } from '../../../src/core/contracts/index.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import type { KeyValueStore } from '../../../src/core/store/types.js';
import { mobileBridge } from '../../../src/mobile/plugin.js';
import { expensesSkill } from '../../../src/skills/expenses/plugin.js';
import { spendingSkill } from '../../../src/skills/spending/plugin.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function start() {
  const home = await mkdtemp(join(tmpdir(), 'axkit-spend-'));
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
    plugins: [mobileBridge({ onListening: (p) => (port = p) }), appChannel({ expiresMinutes: 30 }), spendingSkill(), expensesSkill()],
    storePath: phoneStorePath(home),
  });
  await app.start();
  const base = `http://127.0.0.1:${port}`;
  const handle = openPhoneAdmin(home);
  const paired = await handle.admin.pair({ name: '데스크톱', platform: 'android', client: 'app' });
  await handle.admin.attachFiles(paired.pairing.nonce, [], `${base}|${paired.token}`);
  await handle.close();
  const exchange = await fetch(`${base}/m/p/${paired.pairing.nonce}/app`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: paired.pairing.code }),
  });
  const { token } = (await exchange.json()) as { token: string };
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}/m/v1/app/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads loose JSON
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { app, call };
}

const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

describe('spending view (household ledger)', () => {
  it('adds by hand, re-files with learning, notes, claims, excludes and sets a budget', async () => {
    const { app, call } = await start();
    try {
      const caps = await call('capabilities');
      const spending = caps.body['views'].find((view: { name: string }) => view.name === 'spending');
      expect(spending.actions).toEqual(['categorize', 'note', 'claim', 'exclude', 'add', 'budget']);

      const added = await call('views/spending/add', { merchant: '시장 떡볶이', amount: 6000, date: today(), time: '12:30', category: 'food', note: '현금' });
      expect(added.status).toBe(200);
      const id = added.body['data']['entryId'] as string;
      await call('views/spending/add', { merchant: 'Anthropic', amount: 29400, date: today(), category: 'ai' });

      let view = (await call('views/spending')).body['data'];
      expect(view.total).toBe(35400);
      expect(view.count).toBe(2);
      expect(view.budget).toBeNull();
      expect(view.days).toEqual([{ date: today(), total: 35400, count: 2 }]);
      const lunch = view.entries.find((entry: { id: string }) => entry.id === id);
      expect(lunch).toMatchObject({ merchant: '시장 떡볶이', category: 'food', categoryLabel: '식비', note: '현금', source: 'manual' });
      expect(view.categories).toContainEqual({ id: 'infra', label: '인프라' });
      expect(view.claims).not.toBeNull();

      expect((await call('views/spending/categorize', { entryId: id, category: 'groceries' })).status).toBe(200);
      expect((await call('views/spending/note', { entryId: id, note: '' })).status).toBe(200);
      expect((await call('views/spending/claim', { entryId: id, claim: 'claim' })).body['data']).toEqual({ entryId: id, claim: 'claim' });
      expect((await call('views/spending/budget', { monthly: 1_500_000 })).body['data']).toEqual({ budget: 1_500_000 });
      view = (await call('views/spending')).body['data'];
      const updated = view.entries.find((entry: { id: string }) => entry.id === id);
      expect(updated.category).toBe('groceries');
      expect(updated.categorySource).toBe('owner');
      expect(updated.note).toBeUndefined();
      expect(updated.claim).toBe('candidate');
      expect(view.budget).toBe(1_500_000);

      await call('views/spending/exclude', { entryId: id, excluded: true });
      view = (await call('views/spending')).body['data'];
      expect(view.total).toBe(29400);
      await call('views/spending/budget', { monthly: null });
      expect((await call('views/spending')).body['data'].budget).toBeNull();
    } finally {
      await app.stop('test');
    }
  });

  it('refuses bad input with 400 and an invalid month', async () => {
    const { app, call } = await start();
    try {
      expect((await call('views/spending/add', { merchant: '', amount: -1, date: 'x' })).status).toBe(400);
      expect((await call('views/spending/categorize', { entryId: 'nope', category: 'rockets' })).status).toBe(400);
      expect((await call('views/spending?month=2026-13')).status).toBe(400);
      expect((await call('views/spending/launch', {})).status).toBe(404);
    } finally {
      await app.stop('test');
    }
  });
});

describe('spendingLedgerView without optional skills', () => {
  const memoryKv = (): KeyValueStore => {
    const map = new Map<string, unknown>();
    return {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      set: async (key, value) => void map.set(key, value),
      delete: async (key) => void map.delete(key),
    };
  };

  it('reports claims and subscriptions as null when those tools are missing, and a denied edit as input error', async () => {
    const view = spendingLedgerView({
      reader: () => ({ entries: async () => [], homeCurrency: () => 'KRW' }),
      tools: { execute: async (name) => (name === 'spending.set_category' ? { status: 'denied' } : { status: 'failed', error: 'no tool' }) },
      kv: memoryKv(),
      now: () => new Date('2026-11-18T03:00:00Z'),
      timeZone: 'Asia/Seoul',
      language: 'ko',
    });
    const data = await view.read(new URLSearchParams());
    expect(data).toMatchObject({ month: '2026-11', total: 0, claims: null, subscriptions: null, previousMonth: '2026-10' });
    await expect(view.actions!['categorize']!({ entryId: 'e1', category: 'food' })).rejects.toBeInstanceOf(ViewInputError);
  });
});
