import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApnsRequest, ApnsResult, ApnsTransport } from '../../../src/channels/app/apns.js';
import { createApnsSender, signApnsJwt } from '../../../src/channels/app/apns.js';
import { appTexts } from '../../../src/channels/app/locale.js';
import type { AppEvent } from '../../../src/channels/app/protocol.js';
import { APNS_SECRETS, PushDispatcher, PushRegistry, pushPlan, pushText } from '../../../src/channels/app/push.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import type { Clock } from '../../../src/core/scheduler/types.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { api, events, pairApp, startApp, until } from './harness.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CREDENTIALS = { key: P8, keyId: 'KEYID12345', teamId: 'TEAMID1234' };
const TOKEN = 'a1'.repeat(32);

function fixedClock(start = Date.parse('2026-11-18T10:00:00Z')): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as NodeJS.Timeout);
    },
    advance(ms) {
      now += ms;
    },
  };
}

class FakeTransport implements ApnsTransport {
  readonly requests: ApnsRequest[] = [];
  answer: ApnsResult = { status: 200 };
  async send(request: ApnsRequest): Promise<ApnsResult> {
    this.requests.push(request);
    return this.answer;
  }
  payloads(): Record<string, unknown>[] {
    return this.requests.map((request) => JSON.parse(request.body) as Record<string, unknown>);
  }
}

describe('APNs sender', () => {
  it('signs an ES256 JWT Apple can verify and reuses it for 50 minutes', async () => {
    const jwt = signApnsJwt(CREDENTIALS, 1_700_000_000);
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
    expect(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())).toEqual({ iss: 'TEAMID1234', iat: 1_700_000_000 });
    const ok = verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature ?? '', 'base64url'));
    expect(ok).toBe(true);

    const clock = fixedClock();
    const transport = new FakeTransport();
    let reads = 0;
    const sender = createApnsSender({
      credentials: async () => {
        reads += 1;
        return CREDENTIALS;
      },
      clock,
      transport,
    });
    const target = { token: TOKEN, environment: 'development' as const, topic: 'com.example.app' };
    await sender.send(target, { aps: {} });
    clock.advance(49 * 60_000);
    await sender.send({ ...target, environment: 'production' }, { aps: {} });
    expect(reads).toBe(1);
    clock.advance(2 * 60_000);
    await sender.send(target, { aps: {} });
    expect(reads).toBe(2);
    expect(transport.requests.map((request) => request.host)).toEqual([
      'api.sandbox.push.apple.com',
      'api.push.apple.com',
      'api.sandbox.push.apple.com',
    ]);
    expect(transport.requests[0]).toMatchObject({
      path: `/3/device/${TOKEN}`,
      headers: { 'apns-topic': 'com.example.app', 'apns-push-type': 'alert', authorization: expect.stringMatching(/^bearer /) },
    });
  });

  it('answers no_key without credentials and never throws on a broken key', async () => {
    const transport = new FakeTransport();
    const none = createApnsSender({ credentials: async () => undefined, clock: fixedClock(), transport });
    expect(await none.send({ token: TOKEN, environment: 'production', topic: 'a.b' }, {})).toEqual({ status: 0, reason: 'no_key' });
    const broken = createApnsSender({ credentials: async () => ({ ...CREDENTIALS, key: '-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----' }), clock: fixedClock(), transport });
    expect(await broken.send({ token: TOKEN, environment: 'production', topic: 'a.b' }, {})).toEqual({ status: 0, reason: 'bad_key' });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('push payloads', () => {
  const texts = appTexts('ko');
  const base = { assistantName: '비서', texts, hideContent: false, badge: 2 };

  it('strips markdown and clips the body to 80 characters', () => {
    expect(pushText('**굵게** [링크](https://x.y) `코드`\n# 제목\n> 인용')).toBe('굵게 링크 코드 제목 인용');
    const long = pushText('가'.repeat(100));
    expect(Array.from(long)).toHaveLength(81);
    expect(long.endsWith('…')).toBe(true);
  });

  it('makes a time-sensitive AX_CARD push for cards and skips the owner lines', () => {
    const card: AppEvent = {
      type: 'card',
      seq: 7,
      at: '',
      cardId: 'c1',
      summary: '**민수**에게 보내기',
      effects: ['send'],
      effectLabels: ['보내기'],
      expiresAt: '',
      options: [],
      freeText: true,
    };
    expect(pushPlan(card, base)).toEqual({
      card: true,
      collapseId: 'card:c1',
      payload: {
        aps: {
          alert: { title: '확인이 필요해요', body: '민수에게 보내기' },
          sound: 'default',
          badge: 2,
          'thread-id': 'chat',
          'interruption-level': 'time-sensitive',
          category: 'AX_CARD',
        },
        seq: 7,
        channel: '',
        cardId: 'c1',
        decision: true,
        approveLabel: '승인',
        denyLabel: '거절',
      },
    });
    expect(pushPlan({ type: 'message', seq: 1, at: '', role: 'owner', text: 'hi' }, base)).toBeUndefined();
    expect(pushPlan({ type: 'card_closed', seq: 2, at: '', cardId: 'c1', state: 'approved' }, base)).toBeUndefined();
  });

  it('hides the text when hideContent is on and names a picture-only post', () => {
    const notice: AppEvent = { type: 'notice', seq: 3, at: '', text: '비밀 내용' };
    expect(pushPlan(notice, { ...base, hideContent: true })?.payload['aps']).toMatchObject({
      alert: { title: '비서 알림', body: '새 알림이 있어요' },
    });
    const picture: AppEvent = { type: 'message', seq: 4, at: '', role: 'assistant', text: '', imageUrl: 'https://x.y/a.png' };
    expect(pushPlan(picture, base)?.payload['aps']).toMatchObject({ alert: { title: '비서', body: '사진을 보냈어요' } });
  });
});

describe('push dispatcher', () => {
  function setup(options: { streaming?: boolean; active?: boolean } = {}) {
    const clock = fixedClock();
    const kv = new MapKeyValueStore();
    const registry = new PushRegistry(kv, clock);
    const transport = new FakeTransport();
    const sender = createApnsSender({ credentials: async () => CREDENTIALS, clock, transport });
    const dispatcher = new PushDispatcher({
      registry,
      sender,
      hasStream: () => options.streaming === true,
      deviceActive: async () => options.active !== false,
      openCards: async () => 1,
      assistantName: '비서',
      texts: appTexts('ko'),
      hideContent: false,
      clock,
      log: silentLogger,
    });
    return { clock, registry, transport, dispatcher };
  }
  const notice = (seq: number): AppEvent => ({ type: 'notice', seq, at: '', text: `알림 ${seq}` });

  it('keeps one token per device and moves a token to the device that registers it again', async () => {
    const { registry } = setup();
    await registry.register('d_A', { token: TOKEN, environment: 'production', topic: 'a.b' });
    await registry.register('d_A', { token: 'b2'.repeat(32), environment: 'development', topic: 'a.b' });
    await registry.register('d_B', { token: 'b2'.repeat(32), environment: 'development', topic: 'a.b' });
    expect(Object.keys(await registry.all())).toEqual(['d_B']);
  });

  it('sends nothing to a phone with an open stream, and drops tokens Apple refuses or of unpaired phones', async () => {
    const streaming = setup({ streaming: true });
    await streaming.registry.register('d_A', { token: TOKEN, environment: 'production', topic: 'a.b' });
    streaming.dispatcher.handle(notice(1));
    await streaming.dispatcher.flush();
    expect(streaming.transport.requests).toHaveLength(0);

    const gone = setup();
    await gone.registry.register('d_A', { token: TOKEN, environment: 'production', topic: 'a.b' });
    gone.transport.answer = { status: 410, reason: 'Unregistered' };
    gone.dispatcher.handle(notice(1));
    await gone.dispatcher.flush();
    expect(gone.transport.requests).toHaveLength(1);
    expect(await gone.registry.all()).toEqual({});

    const bad = setup();
    await bad.registry.register('d_A', { token: TOKEN, environment: 'production', topic: 'a.b' });
    bad.transport.answer = { status: 400, reason: 'BadDeviceToken' };
    bad.dispatcher.handle(notice(1));
    await bad.dispatcher.flush();
    expect(await bad.registry.all()).toEqual({});

    const unpaired = setup({ active: false });
    await unpaired.registry.register('d_A', { token: TOKEN, environment: 'production', topic: 'a.b' });
    unpaired.dispatcher.handle(notice(1));
    await unpaired.dispatcher.flush();
    expect(unpaired.transport.requests).toHaveLength(0);
    expect(await unpaired.registry.all()).toEqual({});
  });

  it('limits messages and notices to 30 an hour per phone, never cards', async () => {
    const { registry, transport, dispatcher, clock } = setup();
    await registry.register('d_A', { token: TOKEN, environment: 'production', topic: 'a.b' });
    for (let seq = 1; seq <= 35; seq += 1) dispatcher.handle(notice(seq));
    dispatcher.handle({ type: 'card', seq: 36, at: '', cardId: 'c', summary: 's', effects: ['send'], effectLabels: [], expiresAt: '', options: [], freeText: true });
    await dispatcher.flush();
    expect(transport.requests).toHaveLength(31);
    clock.advance(61 * 60_000);
    dispatcher.handle(notice(37));
    await dispatcher.flush();
    expect(transport.requests).toHaveLength(32);
  });
});

const sendTool = {
  name: 'test.send',
  description: 'sends a picture to someone',
  input: z.object({ to: z.string() }),
  effects: ['send' as const],
  describe: (input: { to: string }) => `Send the poster to ${input.to}`,
  run: async () => 'sent',
};

describe('push over the app channel', () => {
  it('is off without an APNs key: no push feature, push/test answers push_off', async () => {
    const h = await startApp();
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[] };
      expect(caps.features).not.toContain('push');
      expect((await api(h, token, 'push/register', { token: TOKEN, environment: 'production', topic: 'com.example.app' })).status).toBe(200);
      expect((await api(h, token, 'push/test', {})).status).toBe(503);
    } finally {
      await h.stop();
    }
  });

  it('registers the phone, sends a test push and pushes a card while the app is closed', async () => {
    const transport = new FakeTransport();
    const h = await startApp({
      secrets: { [APNS_SECRETS.key]: P8, [APNS_SECRETS.teamId]: 'TEAMID1234' },
      channelConfig: { push: { keyId: 'KEYID12345' } },
      channel: { apnsTransport: transport },
      plugins: [
        {
          manifest: { id: 'skill.test-send', kind: 'skill', title: 'test' },
          setup(ctx) {
            ctx.registerTool(sendTool);
          },
        },
      ],
    });
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[] };
      expect(caps.features).toContain('push');

      expect((await api(h, token, 'push/register', { token: 'zz', environment: 'production', topic: 'a.b' })).status).toBe(400);
      expect((await api(h, token, 'push/test', {})).status).toBe(404);
      const registered = await api(h, token, 'push/register', { token: TOKEN, environment: 'development', topic: 'com.example.app' });
      expect(await registered.json()).toEqual({ ok: true });

      expect(await (await api(h, token, 'push/test', {})).json()).toEqual({ ok: true, status: 200 });
      expect(transport.requests.at(-1)).toMatchObject({ host: 'api.sandbox.push.apple.com', path: `/3/device/${TOKEN}` });

      void h.app.executor.execute('test.send', { to: '민수' });
      await until(() => transport.requests.length === 2);
      const card = (await events(h, token)).find((event) => event.type === 'card');
      expect(transport.payloads().at(-1)).toMatchObject({
        aps: { category: 'AX_CARD', 'interruption-level': 'time-sensitive', alert: { body: 'Send the poster to 민수' }, badge: 1 },
        cardId: card?.type === 'card' ? card.cardId : 'missing',
        decision: true,
      });

      transport.answer = { status: 410, reason: 'Unregistered' };
      expect(await (await api(h, token, 'push/test', {})).json()).toEqual({ ok: false, status: 410, reason: 'Unregistered' });
      expect((await api(h, token, 'push/test', {})).status).toBe(404);
    } finally {
      await h.stop();
    }
  });

  it('skips a phone that holds an open stream and forgets the token when the phone unpairs', async () => {
    const transport = new FakeTransport();
    const h = await startApp({
      secrets: { [APNS_SECRETS.key]: P8, [APNS_SECRETS.keyId]: 'KEYID12345', [APNS_SECRETS.teamId]: 'TEAMID1234' },
      channel: { apnsTransport: transport },
    });
    try {
      const { token } = await pairApp(h);
      await api(h, token, 'push/register', { token: TOKEN, environment: 'production', topic: 'com.example.app' });
      const notifier = h.app.host.capability((await import('../../../src/core/contracts/index.js')).Contracts.notifier)!;

      const controller = new AbortController();
      const response = await fetch(`${h.base}/m/v1/app/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      const reader = response.body!.getReader();
      await reader.read();
      await notifier.notify({ kind: 'test.live', urgent: true, text: '화면에 있어요' });
      await until(async () => (await events(h, token)).some((event) => event.type === 'notice'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transport.requests).toHaveLength(0);
      controller.abort();
      // Wait until the server has seen the stream close (a fixed sleep flakes under a loaded test run).
      const { openSqliteStore } = await import('../../../src/core/store/sqlite.js');
      const { phoneStorePath } = await import('../../../src/app/phone.js');
      const store = openSqliteStore(phoneStorePath(h.home));
      try {
        await until(async () => {
          const presence = await store.kv('channel.app').get<Record<string, { streams: number }>>('presence');
          return Object.values(presence ?? {}).every((record) => record.streams === 0);
        });
      } finally {
        await store.close();
      }

      await notifier.notify({ kind: 'test.away', urgent: true, text: '**택배**가 왔어요' });
      await until(() => transport.requests.length === 1);
      expect(transport.payloads()[0]).toMatchObject({ aps: { alert: { title: '비서 알림', body: '택배가 왔어요' } }, channel: '' });

      expect((await api(h, token, 'unpair', {})).status).toBe(200);
      await notifier.notify({ kind: 'test.after', urgent: true, text: '해제 뒤' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transport.requests).toHaveLength(1);
    } finally {
      await h.stop();
    }
  });
});

describe('ax-kit phone push-test', () => {
  it('sends one test push per registered phone and drops tokens of revoked phones', async () => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openPhoneAdmin, phoneStorePath } = await import('../../../src/app/phone.js');
    const { openSqliteStore } = await import('../../../src/core/store/sqlite.js');
    const { parseConfig } = await import('../../../src/core/config/load.js');
    const { MemorySecretStore } = await import('../../../src/core/secrets/memory.js');
    const { pushTestCommand } = await import('../../../src/cli/phone-push.js');
    const home = await mkdtemp(join(tmpdir(), 'axkit-push-cli-'));
    try {
      await mkdir(join(home, 'data'), { recursive: true });
      const handle = openPhoneAdmin(home);
      const kept = await handle.admin.pair({ name: '폰', platform: 'ios', client: 'app' });
      const gone = await handle.admin.pair({ name: '옛 폰', platform: 'ios', client: 'app' });
      await handle.admin.revoke(gone.device.id);
      await handle.close();
      const store = openSqliteStore(phoneStorePath(home));
      const registry = new PushRegistry(store.kv('channel.app'), fixedClock());
      await registry.register(kept.device.id, { token: TOKEN, environment: 'production', topic: 'com.example.app' });
      await registry.register(gone.device.id, { token: 'c3'.repeat(32), environment: 'production', topic: 'com.example.app' });
      await store.close();

      const lines: string[] = [];
      const transport = new FakeTransport();
      const config = parseConfig({ version: 1, assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' }, channel: 'app' });
      const secrets = new MemorySecretStore({ [APNS_SECRETS.key]: P8, [APNS_SECRETS.keyId]: 'KEYID12345', [APNS_SECRETS.teamId]: 'TEAMID1234' });
      const code = await pushTestCommand({ home, config, secrets, say: (line) => lines.push(line), transport });
      expect(code).toBe(1);
      expect(transport.requests).toHaveLength(1);
      expect(lines.join('\n')).toContain(`${kept.device.id} (폰): 200`);
      expect(lines.join('\n')).not.toContain(TOKEN);

      const after = openSqliteStore(phoneStorePath(home));
      expect(Object.keys(await new PushRegistry(after.kv('channel.app'), fixedClock()).all())).toEqual([kept.device.id]);
      await after.close();

      const none = await pushTestCommand({ home, config, secrets: new MemorySecretStore({}), say: (line) => lines.push(line), transport });
      expect(none).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
