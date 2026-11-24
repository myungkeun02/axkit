import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { App } from '../../../src/app/build.js';
import { buildApp } from '../../../src/app/build.js';
import { openPhoneAdmin, phoneStorePath } from '../../../src/app/phone.js';
import { appChannel } from '../../../src/channels/app/plugin.js';
import type { AppEvent } from '../../../src/channels/app/protocol.js';
import { discordChannel } from '../../../src/channels/discord/plugin.js';
import { parseConfig } from '../../../src/core/config/load.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import type { Plugin } from '../../../src/core/plugin/types.js';
import { mobileBridge } from '../../../src/mobile/plugin.js';
import { greetingSkill } from '../../../src/skills/greeting/plugin.js';
import { knowledgeSkill } from '../../../src/skills/knowledge/plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { flush } from '../../core/helpers.js';
import { FakeDiscordPort } from '../discord/fake-port.js';

const OWNER = '11111111111111111';
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

interface Harness {
  app: App;
  home: string;
  base: string;
  port?: FakeDiscordPort;
  stop(): Promise<void>;
}

const sendTool = {
  name: 'test.send',
  description: 'sends a message to someone',
  input: z.object({ to: z.string() }),
  effects: ['send' as const],
  describe: (input: { to: string }) => `Send hello to ${input.to}`,
  run: async () => 'sent',
};

async function start(channel: 'app' | 'both', extra: Plugin[] = []): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'axkit-app-'));
  homes.push(home);
  const config = parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    channel,
    ...(channel === 'both' ? { owner: { discordUserId: OWNER } } : {}),
    plugins: { 'bridge.mobile': { port: 0 } },
  });
  let listening = 0;
  const discord = channel === 'both' ? new FakeDiscordPort() : undefined;
  const plugins: Plugin[] = [
    mobileBridge({ onListening: (port) => (listening = port) }),
    appChannel({ expiresMinutes: 30, inboxDir: join(home, 'files', 'inbox'), budget: { dailyUsd: 1, monthlyUsd: 20 } }),
    greetingSkill(),
    {
      manifest: { id: 'skill.test-send', kind: 'skill', title: 'test' },
      setup(ctx) {
        ctx.registerTool(sendTool);
      },
    },
  ];
  plugins.push(...extra);
  if (discord !== undefined) {
    plugins.push(discordChannel({ ownerUserId: OWNER, port: () => discord, expiresMinutes: 30 }));
  }
  await mkdir(join(home, 'data'), { recursive: true });
  const app = await buildApp({
    config,
    secrets: new MemorySecretStore({ 'discord.bot-token': 'x' }),
    log: silentLogger,
    plugins,
    storePath: phoneStorePath(home),
  });
  await app.start();
  return {
    app,
    home,
    base: `http://127.0.0.1:${listening}`,
    ...(discord !== undefined ? { port: discord } : {}),
    stop: () => app.stop('test'),
  };
}

async function pairApp(h: Harness, kind: 'app' | 'files' = 'app'): Promise<string> {
  const client = kind === 'app' ? 'app' : undefined;
  const handle = openPhoneAdmin(h.home);
  try {
    const result = await handle.admin.pair({ name: '내 폰', platform: 'android', ...(client ? { client } : {}) });
    await handle.admin.attachFiles(result.pairing.nonce, [], `${h.base}|${result.token}`);
    if (client === undefined) return result.token;
    const response = await fetch(`${h.base}/m/p/${result.pairing.nonce}/app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: result.pairing.code }),
    });
    const body = (await response.json()) as { ok: boolean; token: string; baseUrl: string; deviceId: string };
    expect(body.ok).toBe(true);
    expect(body.baseUrl).toBe(h.base);
    expect(body.deviceId).toBe(result.device.id);
    return body.token;
  } finally {
    await handle.close();
  }
}

function api(h: Harness, token: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${h.base}/m/v1/app/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function events(h: Harness, token: string, after = 0): Promise<AppEvent[]> {
  const body = (await (await api(h, token, `events?after=${after}`)).json()) as { events: AppEvent[] };
  return body.events;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
}

describe('app channel', () => {
  it('pairs with the QR code, chats and keeps one ordered event log', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const status = (await (await api(h, token, 'status')).json()) as { protocol: number; assistant: { name: string } };
      expect(status).toMatchObject({ protocol: 1, assistant: { name: '비서' } });
      const statusAgain = (await (await api(h, token, 'status')).json()) as { serverId: string };
      expect(statusAgain.serverId).toMatch(/^[0-9a-f-]{36}$/);
      expect((status as unknown as { serverId: string }).serverId).toBe(statusAgain.serverId);

      const sent = await api(h, token, 'messages', { text: '안녕', clientId: 'c1' });
      expect(sent.status).toBe(200);
      await until(async () => (await events(h, token)).some((event) => event.type === 'message' && event.role === 'assistant'));
      const log = await events(h, token);
      expect(log[0]).toMatchObject({ type: 'message', role: 'owner', text: '안녕', seq: 1 });
      expect(log[1]).toMatchObject({ type: 'message', role: 'assistant' });

      const again = (await (await api(h, token, 'messages', { text: '안녕', clientId: 'c1' })).json()) as { duplicate?: boolean };
      expect(again.duplicate).toBe(true);
      expect((await events(h, token, 1)).every((event) => event.seq > 1)).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it('turns proactive messages into notices', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const notifier = h.app.host.capability((await import('../../../src/core/contracts/index.js')).Contracts.notifier)!;
      expect(await notifier.notify({ kind: 'test.notice', urgent: true, text: '택배가 왔어요' })).toBe('sent');
      expect((await events(h, token)).at(-1)).toMatchObject({ type: 'notice', text: '택배가 왔어요' });
    } finally {
      await h.stop();
    }
  });

  it('runs a send action only after the app approves its card, and edit counts as no', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const outcome = h.app.executor.execute('test.send', { to: '민수' });
      await until(async () => (await events(h, token)).some((event) => event.type === 'card'));
      const card = (await events(h, token)).find((event) => event.type === 'card');
      expect(card).toMatchObject({ summary: 'Send hello to 민수', effects: ['send'], effectLabels: ['보내기'] });
      const cardId = card?.type === 'card' ? card.cardId : '';
      const press = await api(h, token, `cards/${cardId}`, { decision: 'approve' });
      expect(await press.json()).toMatchObject({ ok: true, state: 'approved' });
      expect(await outcome).toMatchObject({ status: 'done' });
      expect((await api(h, token, `cards/${cardId}`, { decision: 'approve' })).status).toBe(410);

      const second = h.app.executor.execute('test.send', { to: '지수' });
      await until(async () => (await events(h, token)).filter((event) => event.type === 'card').length === 2);
      const next = (await events(h, token)).filter((event) => event.type === 'card').at(-1);
      await api(h, token, `cards/${next?.type === 'card' ? next.cardId : ''}`, { decision: 'edit' });
      expect(await second).toMatchObject({ status: 'denied' });
      const tail = await events(h, token);
      expect(tail.some((event) => event.type === 'card_closed' && event.state === 'edit')).toBe(true);
      expect(tail.at(-1)).toMatchObject({ type: 'message', role: 'assistant', text: expect.stringContaining('고칠') });
    } finally {
      await h.stop();
    }
  });

  it('cards carry options and a reply box; a typed reply is a no that becomes the next instruction', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const outcome = h.app.executor.execute('test.send', { to: '민수' });
      await until(async () => (await events(h, token)).some((event) => event.type === 'card'));
      const card = (await events(h, token)).find((event) => event.type === 'card');
      expect(card).toMatchObject({
        options: [{ id: 'approve', tone: 'primary' }, { id: 'deny', tone: 'danger' }],
        freeText: true,
        remember: { label: expect.stringContaining('Send hello to 민수') },
      });
      const cardId = card?.type === 'card' ? card.cardId : '';
      expect((await api(h, token, `cards/${cardId}`, { option: 'nope' })).status).toBe(400);
      const reply = await api(h, token, `cards/${cardId}`, { text: '민수 말고 지수에게 보내 줘' });
      expect(await reply.json()).toMatchObject({ ok: true, state: 'edit', reply: '민수 말고 지수에게 보내 줘' });
      expect(await outcome).toMatchObject({ status: 'denied' });
      const tail = await events(h, token);
      expect(tail.find((event) => event.type === 'card_closed')).toMatchObject({ state: 'edit', answer: '민수 말고 지수에게 보내 줘' });
      expect(tail.at(-1)).toMatchObject({ type: 'message', role: 'owner', text: '민수 말고 지수에게 보내 줘' });
    } finally {
      await h.stop();
    }
  });

  it('"from now on" makes a rule: the same action then runs without a card, until revoked', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const first = h.app.executor.execute('test.send', { to: '민수' });
      await until(async () => (await events(h, token)).some((event) => event.type === 'card'));
      const card = (await events(h, token)).find((event) => event.type === 'card');
      await api(h, token, `cards/${card?.type === 'card' ? card.cardId : ''}`, { option: 'approve', remember: true });
      expect(await first).toMatchObject({ status: 'done' });

      expect(await h.app.executor.execute('test.send', { to: '민수' })).toMatchObject({ status: 'done' });
      expect((await events(h, token)).filter((event) => event.type === 'card')).toHaveLength(1);
      await until(async () => (await events(h, token)).some((event) => event.type === 'notice' && event.text.includes('알아서 했어요')));

      const view = (await (await api(h, token, 'views/autonomy')).json()) as { data: { rules: { id: string; uses: number }[] } };
      expect(view.data.rules).toHaveLength(1);
      expect(view.data.rules[0]).toMatchObject({ uses: 1, origin: 'card', approvals: 1, denials: 0, corrections: 0 });
      expect(view.data.rules[0]).not.toHaveProperty('paused');
      await api(h, token, 'views/autonomy/revoke', { id: view.data.rules[0]?.id });
      const again = h.app.executor.execute('test.send', { to: '민수' });
      await until(async () => (await events(h, token)).filter((event) => event.type === 'card').length === 2);
      const next = (await events(h, token)).filter((event) => event.type === 'card').at(-1);
      await api(h, token, `cards/${next?.type === 'card' ? next.cardId : ''}`, { option: 'deny' });
      expect(await again).toMatchObject({ status: 'denied' });

      // a different action is outside the rule
      const other = h.app.executor.execute('test.send', { to: '지수' });
      await until(async () => (await events(h, token)).filter((event) => event.type === 'card').length === 3);
      const third = (await events(h, token)).filter((event) => event.type === 'card').at(-1);
      await api(h, token, `cards/${third?.type === 'card' ? third.cardId : ''}`, { option: 'deny' });
      expect(await other).toMatchObject({ status: 'denied' });
    } finally {
      await h.stop();
    }
  });

  it('calendar view lists every day of the month with what was done', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const outcome = h.app.executor.execute('test.send', { to: '민수' });
      await until(async () => (await events(h, token)).some((event) => event.type === 'card'));
      const card = (await events(h, token)).find((event) => event.type === 'card');
      await api(h, token, `cards/${card?.type === 'card' ? card.cardId : ''}`, { option: 'approve' });
      await outcome;
      const month = new Date().toISOString().slice(0, 7);
      const body = (await (await api(h, token, `views/calendar?month=${month}`)).json()) as {
        data: { month: string; days: { date: string; events: unknown[]; done: { title: string }[] }[] };
      };
      expect(body.data.month).toBe(month);
      expect(body.data.days.length).toBeGreaterThanOrEqual(28);
      expect(body.data.days.flatMap((day) => day.done).map((d) => d.title)).toContain('Send hello to 민수');
      expect((await api(h, token, 'views/calendar?month=2026-13')).status).toBe(400);
    } finally {
      await h.stop();
    }
  });

  it('status says when everything is stopped, and the stop beats a rule', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const kill = h.app.host.capability(Contracts.killSwitch)!;
      expect(await (await api(h, token, 'status')).json()).toMatchObject({ stopped: false });
      await kill.stop('test', 'owner');
      expect(await (await api(h, token, 'status')).json()).toMatchObject({ stopped: true });
      expect(await h.app.executor.execute('test.send', { to: '민수' })).toMatchObject({ status: 'rejected' });
    } finally {
      await h.stop();
    }
  });

  it('refuses chat and approvals from signal-only tokens', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h, 'files');
      expect((await api(h, token, 'messages', { text: 'hi' })).status).toBe(403);
      expect((await api(h, 'wrong', 'status')).status).toBe(401);
    } finally {
      await h.stop();
    }
  });

  it('in both mode, a card answered in the app closes on Discord', async () => {
    const h = await start('both');
    try {
      const token = await pairApp(h);
      const outcome = h.app.executor.execute('test.send', { to: '민수' });
      await until(async () => (await events(h, token)).some((event) => event.type === 'card') && (h.port?.sent.length ?? 0) > 0);
      const card = (await events(h, token)).find((event) => event.type === 'card');
      await api(h, token, `cards/${card?.type === 'card' ? card.cardId : ''}`, { decision: 'deny' });
      expect(await outcome).toMatchObject({ status: 'denied' });
      await until(async () => (h.port?.edits.length ?? 0) > 0);
      expect(h.port?.edits[0]?.note).toContain('다른 곳');

      const notifier = h.app.host.capability((await import('../../../src/core/contracts/index.js')).Contracts.notifier)!;
      await notifier.notify({ kind: 'test.both', urgent: true, text: '둘 다' });
      expect((await events(h, token)).at(-1)).toMatchObject({ type: 'notice', text: '둘 다' });
      expect(h.port?.sent.at(-1)?.payload.content).toBe('둘 다');
    } finally {
      await h.stop();
    }
  });

  it('saves a shared photo privately and tells the assistant', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const response = await fetch(`${h.base}/m/v1/app/share`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg', 'x-file-name': encodeURIComponent('../영수증.jpg') },
        body: Buffer.from([0xff, 0xd8, 0xff]),
      });
      expect(response.status).toBe(200);
      const log = await events(h, token);
      expect(log.at(0)).toMatchObject({ type: 'message', role: 'owner', text: expect.stringContaining('사진') });
      const { readdir } = await import('node:fs/promises');
      const month = (await readdir(join(h.home, 'files', 'inbox')))[0]!;
      const [file] = await readdir(join(h.home, 'files', 'inbox', month));
      expect(file).toMatch(/영수증\.jpg$/);
      expect(file).not.toContain('/');
      const path = join(h.home, 'files', 'inbox', month, file!);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await readFile(path)).length).toBe(3);
    } finally {
      await h.stop();
    }
  });

  it('streams missed events after Last-Event-ID, then live ones', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      await api(h, token, 'messages', { text: '안녕' });
      await until(async () => (await events(h, token)).length >= 2);
      const controller = new AbortController();
      const response = await fetch(`${h.base}/m/v1/app/stream`, {
        headers: { authorization: `Bearer ${token}`, 'last-event-id': '1' },
        signal: controller.signal,
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      let text = '';
      const notifier = h.app.host.capability((await import('../../../src/core/contracts/index.js')).Contracts.notifier)!;
      await notifier.notify({ kind: 'test.live', urgent: true, text: '실시간' });
      while (!text.includes('실시간')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      controller.abort();
      expect(text).not.toContain('id: 1\n');
      expect(text).toContain('id: 2\n');
      expect(text).toContain('event: notice');
    } finally {
      await h.stop();
    }
  });
});

describe('app views', () => {
  it('lists views in capabilities and serves the today summary', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { views: { name: string }[]; features: string[] };
      expect(caps.views.map((view) => view.name)).toContain('today');
      expect(caps.features).toContain('cards');
      const today = (await (await api(h, token, 'views/today')).json()) as { data: { events: unknown; todos: unknown; pendingCards: number } };
      expect(today.data).toMatchObject({ events: null, pendingCards: 0 });
      expect((await api(h, token, 'views/nope')).status).toBe(404);
    } finally {
      await h.stop();
    }
  });
});

describe('usage, approvals, health and knowledge views', () => {
  it('serves usage by period with totals and the budget', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { views: { name: string; actions: string[] }[] };
      expect(caps.views.map((view) => view.name)).toEqual(expect.arrayContaining(['today', 'approvals', 'usage', 'health', 'improvements']));
      const usage = (await (await api(h, token, 'views/usage?period=week')).json()) as { data: Record<string, unknown> };
      expect(usage.data).toMatchObject({ period: 'week', totals: { calls: 0, failures: 0, failureRate: 0 }, byModel: [], budget: { dailyUsd: 1 } });
      const health = (await (await api(h, token, 'views/health')).json()) as { data: { findings: unknown[] } };
      expect(Array.isArray(health.data.findings)).toBe(true);
      const approvals = (await (await api(h, token, 'views/approvals')).json()) as { data: { cards: unknown[] } };
      expect(approvals.data.cards).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  it('lists knowledge documents and takes a line fix from the app', async () => {
    const h = await start('app', [knowledgeSkill()]);
    try {
      const token = await pairApp(h);
      const writer = h.app.host.capability(Contracts.knowledgeWrite)!;
      await writer.replaceScan({
        profile: [{ area: 'profile', topic: 'role', key: 'job', text: '디자이너로 일한다', sources: ['~/Documents/cv.md'], at: '2026-11-18T00:00:00Z' }],
        projects: [],
      });
      const list = (await (await api(h, token, 'views/knowledge')).json()) as { data: { documents: { name: string; kind: string; lines: number }[] } };
      const profile = list.data.documents.find((doc) => doc.kind === 'profile')!;
      expect(profile.lines).toBe(1);
      const doc = (await (await api(h, token, `views/knowledge?doc=${encodeURIComponent(profile.name)}`)).json()) as {
        data: { document: { markdown: string; lines: { id: string; text: string }[] } };
      };
      expect(doc.data.document.markdown).toContain('디자이너');
      const lineId = doc.data.document.lines[0]!.id;
      const fixed = await api(h, token, 'views/knowledge/correct', { lineId, text: '개발자로 일한다' });
      expect(await fixed.json()).toMatchObject({ ok: true, data: { corrected: true } });
      const after = (await (await api(h, token, `views/knowledge?doc=${encodeURIComponent(profile.name)}`)).json()) as {
        data: { document: { markdown: string } };
      };
      expect(after.data.document.markdown).toContain('개발자');
      expect((await api(h, token, 'views/knowledge/correct', { lineId: 'nope', text: 'x' })).status).toBe(400);
      expect((await api(h, token, 'views/knowledge/remove', {})).status).toBe(404);
    } finally {
      await h.stop();
    }
  });

  it('docgraph shows documents as points and links, and opens one', async () => {
    const h = await start('app', [knowledgeSkill()]);
    try {
      const token = await pairApp(h);
      const writer = h.app.host.capability(Contracts.knowledgeWrite)!;
      await writer.replaceScan({
        profile: [{ area: 'profile', topic: 'role', key: 'job', text: '한빛랩을 운영한다', sources: ['~/Documents/plan.md'], at: '2026-11-18T00:00:00Z' }],
        projects: [{ area: 'project', topic: '두부앱', key: 'goal', text: '한빛랩의 첫 앱', sources: ['~/Documents/plan.md'], at: '2026-11-18T00:00:00Z' }],
      });
      const docs = h.app.host.capability(Contracts.docs)!;
      const author = { kind: 'agent' as const, id: 'test' };
      await docs.upsert({ id: 'company:hanbit', kind: 'company', scope: 'hanbit', title: '한빛랩', body: '앱 만드는 회사', author });
      await docs.upsert({ id: 'company:team:dev', kind: 'team', scope: 'team:hanbit', title: '개발팀', body: '두부앱을 만든다', author });
      await flush();
      const graph = (await (await api(h, token, 'views/docgraph')).json()) as {
        data: { layers: { id: string }[]; nodes: { id: string; title: string; layer: string; weight: number }[]; links: { from: string; to: string; label: string }[] };
      };
      const titles = graph.data.nodes.map((node) => node.title);
      expect(titles).toEqual(expect.arrayContaining(['한빛랩', '개발팀', '두부앱']));
      expect(graph.data.layers.map((layer) => layer.id)).toEqual(expect.arrayContaining(['profile', 'project', 'company', 'team']));
      const idOf = (title: string) => graph.data.nodes.find((node) => node.title === title)?.id ?? '';
      const linked = (a: string, b: string) => graph.data.links.some((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a));
      expect(linked(idOf('한빛랩'), idOf('개발팀'))).toBe(true);
      expect(linked(idOf('개발팀'), idOf('두부앱'))).toBe(true);
      const profile = graph.data.nodes.find((node) => node.layer === 'profile')!;
      expect(linked(profile.id, idOf('두부앱'))).toBe(true);
      const open = (await (await api(h, token, `views/docgraph?doc=${encodeURIComponent(idOf('개발팀'))}`)).json()) as {
        data: { document: { markdown: string; related: { title: string }[] } };
      };
      expect(open.data.document.markdown).toContain('두부앱을 만든다');
      expect(open.data.document.related.map((r) => r.title)).toContain('한빛랩');
    } finally {
      await h.stop();
    }
  });

  it('bots view, bot rooms and hand-off lines', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const bots = h.app.host.capability(Contracts.bots)!;
      await bots.upsertGroup({ id: 'hanbit', label: '한빛랩', summary: '앱 만드는 회사' });
      await bots.upsert({ id: 'dev', name: '개발 봇', role: '앱·서버 코드를 고쳐요', group: 'hanbit', kind: 'dev', origin: 'owner' });
      await bots.upsert({ id: 'life', name: '생활 봇', role: '장보기와 예약', kind: 'general', origin: 'owner' });
      const view = (await (await api(h, token, 'views/bots')).json()) as {
        data: { main: { name: string }; groups: { id: string; label: string; bots: { id: string; channel: string; status: string }[] }[] };
      };
      expect(view.data.main.name).toBe('비서');
      expect(view.data.groups.map((g) => [g.label, g.bots.map((b) => b.id)])).toEqual([['한빛랩', ['dev']], ['기타', ['life']]]);

      expect((await api(h, token, 'messages', { text: '안녕', channel: 'nobody' })).status).toBe(400);
      await api(h, token, 'messages', { text: '안녕', channel: 'dev' });
      await until(async () => (await events(h, token)).some((event) => event.type === 'message' && event.role === 'assistant'));
      const reply = (await events(h, token)).find((event) => event.type === 'message' && event.role === 'assistant');
      expect(reply).toMatchObject({ channel: 'dev', author: { id: 'dev', name: '개발 봇' } });

      await h.app.bus.emit('bots.delegation', { bot: { id: 'dev', name: '개발 봇' }, task: '로그인 화면 고치기', state: 'started' });
      await h.app.bus.emit('bots.message', { bot: { id: 'dev', name: '개발 봇' }, text: '고쳤어요' });
      const all = await events(h, token);
      expect(all.find((event) => event.type === 'delegation')).toMatchObject({ botChannel: 'dev', task: '로그인 화면 고치기', state: 'started' });
      const main = (await (await api(h, token, 'events?channel=')).json()) as { events: AppEvent[] };
      expect(main.events.filter((e) => e.type === 'message')).toEqual([]);
      expect(main.events.some((e) => e.type === 'delegation')).toBe(true);
      const room = (await (await api(h, token, 'events?channel=dev')).json()) as { events: AppEvent[] };
      expect(room.events.filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.text : ''))).toContain('고쳤어요');
    } finally {
      await h.stop();
    }
  });

  it('topic questions show their choices, reuse an open card, and are not asked again (R15)', async () => {
    const h = await start('app');
    try {
      const token = await pairApp(h);
      const questions = h.app.host.capability(Contracts.questions)!;
      const choices = [
        { id: 'bot', label: '개발 봇에게 맡기기', tone: 'primary' as const, means: 'approved' as const },
        { id: 'later', label: '나중에', means: 'later' as const },
        { id: 'no', label: '안 함', tone: 'danger' as const, means: 'denied' as const },
      ];
      const ask = (note: string) => questions.ask({ topic: 'dev:suggest:export', summary: '이걸로 개발해 볼까요?', note, choices, askedBy: 'test' });
      const first = ask('회의 1에서 나온 말');
      await until(async () => (await events(h, token)).some((e) => e.type === 'card'));
      const second = ask('회의 2에서도 같은 말');
      await until(async () => (await events(h, token)).filter((e) => e.type === 'card').length === 2);
      const cards = (await events(h, token)).filter((e) => e.type === 'card');
      const [a, b] = cards.map((c) => (c.type === 'card' ? c : undefined));
      expect(a?.cardId).toBe(b?.cardId);
      expect(b).toMatchObject({ topic: 'dev:suggest:export', note: '회의 2에서도 같은 말', options: [{ id: 'bot' }, { id: 'later' }, { id: 'no' }] });
      expect(await first).toEqual({ status: 'expired' });
      await api(h, token, `cards/${b?.cardId ?? ''}`, { option: 'no' });
      expect(await second).toMatchObject({ status: 'answered', choice: 'no' });
      expect(await ask('회의 3')).toEqual({ status: 'skipped', reason: 'declined' });
      expect((await events(h, token)).filter((e) => e.type === 'card')).toHaveLength(2);
    } finally {
      await h.stop();
    }
  });

  it('calendar add puts an owner event on the calendar when a calendar can write', async () => {
    const created: unknown[] = [];
    const calendar: Plugin = {
      manifest: { id: 'test.calendar', kind: 'connector', title: 'cal' },
      setup(ctx) {
        ctx.provide(Contracts.calendarRead, { listEvents: async () => [] });
        ctx.provide(Contracts.calendarWrite, {
          createEvent: async (draft) => {
            created.push(draft);
            return { id: 'e1', title: draft.title, start: draft.start, end: draft.end, allDay: draft.allDay };
          },
        });
      },
    };
    const h = await start('app', [calendar]);
    try {
      const token = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { views: { name: string; actions: string[] }[] };
      expect(caps.views.find((v) => v.name === 'calendar')?.actions).toEqual(['add']);
      const ok = await api(h, token, 'views/calendar/add', { title: '치과', allDay: false, start: '2026-11-20T15:00:00+09:00', place: '강남' });
      expect(await ok.json()).toMatchObject({ ok: true, data: { id: 'e1' } });
      expect(created[0]).toMatchObject({ title: '치과', allDay: false, location: '강남', end: '2026-11-20T07:00:00.000Z' });
      await api(h, token, 'views/calendar/add', { title: '휴가', allDay: true, start: '2026-11-21' });
      expect(created[1]).toMatchObject({ allDay: true, start: '2026-11-21', end: '2026-11-22' });
      expect((await api(h, token, 'views/calendar/add', { title: 'x', allDay: true, start: '2026-11-21T10:00' })).status).toBe(400);
    } finally {
      await h.stop();
    }
  });
});
