import { describe, expect, it } from 'vitest';
import type { BrowserLiveHub, LiveBrowser, LiveFrame, LiveKey } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Logger } from '../../../src/core/log/types.js';
import type { BrowserOpenOutput } from '../../../src/skills/browser/tool-open.js';
import type { BrowserRunOutput } from '../../../src/skills/browser/output.js';
import { LIVE_IDLE_MS, LiveHub } from '../../../src/skills/browser/live-hub.js';
import { browserSkill } from '../../../src/skills/browser/plugin.js';
import { FakeClock, flush } from '../../core/helpers.js';
import { FakeConfirmer, createTestContext } from '../../support/context.js';
import { FakeBrowserAgent } from './helpers.js';
import { settler } from '../work/settle.js';

class FakeLive implements LiveBrowser {
  readonly inputs: string[] = [];
  closed = false;
  constructor(private readonly url: string) {}
  async frame(): Promise<LiveFrame> {
    return { jpeg: Buffer.from([0xff, 0xd8, 0xff]), width: 824, height: 1720, url: this.url, title: '로그인' };
  }
  async tap(x: number, y: number): Promise<void> {
    this.inputs.push(`tap ${x},${y}`);
  }
  async type(text: string): Promise<void> {
    this.inputs.push(`type ${text.length}`);
  }
  async key(name: LiveKey): Promise<void> {
    this.inputs.push(`key ${name}`);
  }
  async scroll(dy: number): Promise<void> {
    this.inputs.push(`scroll ${dy}`);
  }
  async back(): Promise<void> {
    this.inputs.push('back');
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class LiveAgent extends FakeBrowserAgent {
  readonly lives: FakeLive[] = [];
  failLive = false;
  released = 0;
  async releaseKept(): Promise<void> {
    this.released += 1;
  }
  async openLive(url: string): Promise<LiveBrowser> {
    if (this.failLive) throw new Error('busy');
    const live = new FakeLive(url);
    this.lives.push(live);
    return live;
  }
}

function recordingLogger(lines: string[]): Logger {
  const write = (msg: string, fields?: Record<string, unknown>): void => {
    lines.push(`${msg} ${JSON.stringify(fields ?? {})}`);
  };
  const logger: Logger = { debug: write, info: write, warn: write, error: write, child: () => logger };
  return logger;
}

function hubWith(options: { stopped?: boolean } = {}) {
  const clock = new FakeClock(new Date('2026-11-20T09:00:00+09:00'));
  const agent = new LiveAgent();
  const logs: string[] = [];
  const kill = { stopped: options.stopped ?? false };
  const hub = new LiveHub({
    agent,
    clock,
    log: recordingLogger(logs),
    killSwitch: () => ({
      state: async () => ({ stopped: kill.stopped }) as never,
      stop: async () => ({}) as never,
      resume: async () => ({}) as never,
    }),
  });
  return { clock, agent, logs, kill, hub };
}

describe('live browser hub', () => {
  it('opens only a page a handoff offered, and takes no input before that', async () => {
    const { agent, hub } = hubWith();
    expect(await hub.start()).toBe(false);
    expect(await hub.input({ kind: 'tap', x: 1, y: 1 })).toBe('not_live');
    expect(await hub.frame()).toBeUndefined();

    hub.offer('https://example.com/login', 'login');
    expect(hub.state()).toMatchObject({ live: false, pending: { url: 'https://example.com/login', reason: 'login' } });
    const [a, b] = await Promise.all([hub.start(), hub.start()]);
    expect(a && b).toBe(true);
    expect(agent.lives).toHaveLength(1);
    expect(hub.state()).toMatchObject({ live: true, url: 'https://example.com/login', reason: 'login' });
  });

  it('clamps coordinates to the frame, rate-limits inputs and never logs typed text', async () => {
    const { agent, hub, logs } = hubWith();
    hub.offer('https://example.com/login', 'login');
    await hub.start();
    await hub.frame();
    expect(await hub.input({ kind: 'tap', x: 5000, y: -3 })).toBe('ok');
    expect(await hub.input({ kind: 'type', text: 'secret-pw-123' })).toBe('ok');
    expect(await hub.input({ kind: 'scroll', dy: 99_999 })).toBe('ok');
    const results = [];
    for (let i = 0; i < 10; i += 1) results.push(await hub.input({ kind: 'key', key: 'Tab' }));
    expect(results).toContain('too_fast');
    expect(agent.lives[0]?.inputs.slice(0, 3)).toEqual(['tap 823,0', 'type 13', 'scroll 4000']);
    expect(logs.join('\n')).not.toContain('secret-pw-123');
  });

  it('closes after 15 idle minutes and on the kill switch', async () => {
    const idle = hubWith();
    idle.hub.offer('https://example.com/', 'other');
    await idle.hub.start();
    await idle.clock.advance(LIVE_IDLE_MS + 60_000);
    await flush();
    expect(idle.agent.lives[0]?.closed).toBe(true);
    expect(idle.hub.state()).toMatchObject({ live: false, closed: 'idle' });

    const stop = hubWith();
    stop.hub.offer('https://example.com/', 'captcha');
    await stop.hub.start();
    stop.kill.stopped = true;
    expect(await stop.hub.input({ kind: 'tap', x: 1, y: 1 })).toBe('not_live');
    expect(stop.agent.lives[0]?.closed).toBe(true);
    expect(stop.hub.state().closed).toBe('stopped');
    stop.hub.offer('https://example.com/', 'captcha');
    expect(await stop.hub.start()).toBe(false);
  });

  it('done closes the page, clears the handoff and tells which site it was', async () => {
    const { agent, hub } = hubWith();
    const seen: boolean[] = [];
    hub.subscribe((state) => seen.push(state.live));
    hub.offer('https://shop.example.com/cart', 'consent');
    await hub.start();
    expect(await hub.finish()).toEqual({ wasLive: true, host: 'shop.example.com' });
    expect(agent.lives[0]?.closed).toBe(true);
    expect(hub.state()).toEqual({ live: false, closed: 'done' });
    expect(seen).toEqual([false, true, false]);
  });

  it('frees a kept page when the owner is done without opening it, on the kill switch and at shutdown', async () => {
    const done = hubWith();
    done.hub.offer('https://shop.example.com/login', 'login', { channelId: 'channel.discord', address: 'dm-1', replyTo: 'msg-1' });
    expect(await done.hub.finish()).toEqual({ wasLive: false, host: 'shop.example.com', origin: { channelId: 'channel.discord', address: 'dm-1' } });
    expect(done.agent.released).toBe(1);

    const opened = hubWith();
    opened.hub.offer('https://shop.example.com/login', 'login', { channelId: 'channel.app', address: 'owner' });
    await opened.hub.start();
    expect(await opened.hub.finish()).toMatchObject({ wasLive: true, origin: { channelId: 'channel.app', address: 'owner' } });
    // the live view took the kept page over and closed it itself
    expect(opened.agent.released).toBe(0);

    const stop = hubWith();
    stop.hub.offer('https://example.com/', 'login');
    stop.kill.stopped = true;
    await stop.clock.advance(60_000);
    await flush();
    expect(stop.agent.released).toBe(1);
    expect(stop.hub.state()).toEqual({ live: false, closed: 'stopped' });

    const shut = hubWith();
    shut.hub.offer('https://example.com/', 'login');
    await shut.hub.shutdown();
    expect(shut.agent.released).toBe(1);
  });

  it('reports a busy profile as a failed start', async () => {
    const { agent, hub } = hubWith();
    agent.failLive = true;
    hub.offer('https://example.com/', 'login');
    expect(await hub.start()).toBe(false);
    expect(hub.state().live).toBe(false);
  });
});

async function skillWith(options: { app: boolean; agent?: FakeBrowserAgent }) {
  const agent = options.agent ?? new LiveAgent();
  const context = createTestContext({
    capabilities: {
      [Contracts.browser.id]: agent,
      ...(options.app ? { [Contracts.appViews.id]: { register: () => undefined } } : {}),
    },
    confirmer: new FakeConfirmer('approved'),
  });
  const settled = settler();
  await browserSkill({ onSettled: settled.onSettled }).setup(context.ctx);
  return { ...context, agent, settled };
}

describe('browser skill with the app browser screen', () => {
  it('a handoff offers the page to the app and the guide says so', async () => {
    const context = await skillWith({ app: true });
    context.agent.result = { status: 'needs_human', summary: '로그인', url: 'https://example.com/login', handoff: { reason: 'login', url: 'https://example.com/login' } };
    await context.ctx.tools.execute('browser.task', { goal: '주문 내역 보기', startUrl: 'https://example.com/' });
    const output = await context.settled.next<BrowserRunOutput>();
    expect(output.liveView).toBe('browser-live');
    expect(output.handoff?.guide).toContain('앱의 브라우저 화면에서 직접 하실 수 있어요');
    const hub = context.provided.get(Contracts.browserLive.id) as BrowserLiveHub;
    expect(hub.state().pending).toMatchObject({ url: 'https://example.com/login', reason: 'login' });
    // the adapter keeps the page for the app instead of closing it
    expect(context.agent.tasks[0]?.keepPage).toBe(true);
  });

  it('remembers the conversation the errand came from, for "done"', async () => {
    const context = await skillWith({ app: true });
    context.agent.result = { status: 'needs_human', summary: '로그인', url: 'https://example.com/login', handoff: { reason: 'login', url: 'https://example.com/login' } };
    await context.ctx.tools.execute('browser.task', { goal: '주문 내역 보기', startUrl: 'https://example.com/' }, {
      grounding: [],
      conversation: { channelId: 'channel.app', address: 'bot:mina', replyTo: 'app:3' },
    });
    await context.settled.next();
    const hub = context.provided.get(Contracts.browserLive.id) as BrowserLiveHub;
    expect((await hub.finish()).origin).toEqual({ channelId: 'channel.app', address: 'bot:mina' });
  });

  it('without the app channel the handoff stays as before', async () => {
    const context = await skillWith({ app: false });
    context.agent.result = { status: 'needs_human', summary: '로그인', url: 'https://example.com/login', handoff: { reason: 'login' } };
    await context.ctx.tools.execute('browser.task', { goal: '주문 내역 보기', startUrl: 'https://example.com/' });
    const output = await context.settled.next<BrowserRunOutput>();
    expect(output.liveView).toBeUndefined();
    expect(output.handoff?.guide).not.toContain('앱의 브라우저 화면');
    expect(context.agent.tasks[0]?.keepPage).toBeUndefined();
  });

  it("browser.open_for_me puts the page in the app unless the owner asked for the Mac's screen", async () => {
    const context = await skillWith({ app: true });
    const inApp = await context.ctx.tools.execute('browser.open_for_me', { url: 'https://example.com/pay' });
    expect((inApp as { output: BrowserOpenOutput }).output).toMatchObject({ status: 'opened', url: 'https://example.com/pay', liveView: 'browser-live' });
    expect(context.agent.opened).toEqual([]);
    await context.ctx.tools.execute('browser.open_for_me', { url: 'https://example.com/pay', on: 'mac' });
    expect(context.agent.opened).toEqual(['https://example.com/pay']);
  });

  it('an adapter without live pages provides no hub', async () => {
    const context = await skillWith({ app: true, agent: new FakeBrowserAgent() });
    expect(context.provided.has(Contracts.browserLive.id)).toBe(false);
  });
});
