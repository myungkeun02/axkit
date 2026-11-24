import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from '../../../src/core/conversation/types.js';
import type { BrowserAgent, LiveBrowser, LiveFrame, LiveKey } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Plugin } from '../../../src/core/plugin/types.js';
import { LiveHub } from '../../../src/skills/browser/live-hub.js';
import { api, events, pairApp, startApp, until } from './harness.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

class FakeLive implements LiveBrowser {
  readonly inputs: string[] = [];
  closed = false;
  async frame(): Promise<LiveFrame> {
    return { jpeg: JPEG, width: 824, height: 1720, url: 'https://example.com/login', title: '로그인' };
  }
  async tap(x: number, y: number): Promise<void> {
    this.inputs.push(`tap ${x},${y}`);
  }
  async type(text: string): Promise<void> {
    this.inputs.push(`type ${text}`);
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

function livePlugin(state: { hub?: LiveHub; live?: FakeLive; received: IncomingMessage[] }): Plugin {
  const agent: BrowserAgent = {
    label: 'fake',
    read: async () => ({ status: 'done', summary: '' }),
    run: async () => ({ status: 'done', summary: '' }),
    openLive: async () => {
      state.live = new FakeLive();
      return state.live;
    },
  };
  return {
    manifest: { id: 'skill.test-live', kind: 'skill', title: 'live' },
    setup(ctx) {
      state.hub = new LiveHub({ agent, clock: ctx.clock, log: ctx.log, killSwitch: () => undefined });
      ctx.provide(Contracts.browserLive, state.hub);
      ctx.bus.on('message.received', (message) => {
        state.received.push(message);
      });
    },
  };
}

describe('browser-live view (§22)', () => {
  it('is listed only with a live-capable browser', async () => {
    const h = await startApp();
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[]; views: { name: string }[] };
      expect(caps.features).not.toContain('browser-live');
      expect(caps.views.map((view) => view.name)).not.toContain('browser-live');
    } finally {
      await h.stop();
    }
  });

  it('lets the owner open a handoff, tap, type and finish, and tells the assistant to continue', async () => {
    const state: { hub?: LiveHub; live?: FakeLive; received: IncomingMessage[] } = { received: [] };
    const h = await startApp({ plugins: [livePlugin(state)] });
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as {
        features: string[];
        views: { name: string; actions: string[] }[];
      };
      expect(caps.features).toContain('browser-live');
      expect(caps.views.find((view) => view.name === 'browser-live')?.actions).toEqual(['start', 'tap', 'type', 'key', 'scroll', 'back', 'done']);

      // nothing to open or drive before a handoff
      expect((await api(h, token, 'views/browser-live/start', {})).status).toBe(400);
      const early = await api(h, token, 'views/browser-live/tap', { x: 1, y: 1 });
      expect(early.status).toBe(400);
      expect(((await early.json()) as { message: string }).message).toContain('닫혀');
      expect((await api(h, token, 'browser-live/frame')).status).toBe(404);

      state.hub?.offer('https://example.com/login', 'login');
      const pending = (await (await api(h, token, 'views/browser-live')).json()) as { data: Record<string, unknown> };
      expect(pending.data).toMatchObject({ live: false, pending: { url: 'https://example.com/login', reason: 'login' }, frameUrl: 'browser-live/frame' });
      const started = (await (await api(h, token, 'views/browser-live/start', {})).json()) as { data: Record<string, unknown> };
      expect(started.data).toMatchObject({ live: true, url: 'https://example.com/login', reason: 'login' });

      const frame = await api(h, token, 'browser-live/frame');
      expect(frame.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await frame.arrayBuffer()).equals(JPEG)).toBe(true);
      expect((await fetch(`${h.base}/m/v1/app/browser-live/frame`)).status).toBe(401);

      const tap = (await (await api(h, token, 'views/browser-live/tap', { x: 100, y: 200 })).json()) as { data: unknown };
      expect(tap.data).toEqual({ accepted: true });
      await api(h, token, 'views/browser-live/type', { text: 'my-secret-pw' });
      await api(h, token, 'views/browser-live/key', { name: 'Enter' });
      expect((await api(h, token, 'views/browser-live/key', { name: 'F12' })).status).toBe(400);
      expect((await api(h, token, 'views/browser-live/tap', { x: 'a' })).status).toBe(400);
      expect(state.live?.inputs).toEqual(['tap 100,200', 'type my-secret-pw', 'key Enter']);

      const done = (await (await api(h, token, 'views/browser-live/done', {})).json()) as { data: Record<string, unknown> };
      expect(done.data).toMatchObject({ live: false, closed: 'done', resumed: true });
      expect(state.live?.closed).toBe(true);
      await until(() => state.received.length > 0);
      expect(state.received[0]).toMatchObject({ fromOwner: true, conversation: { channelId: 'channel.app', address: 'owner' } });
      expect(state.received[0]?.text).toContain('example.com');
      const log = JSON.stringify(await events(h, token));
      expect(log).toContain('계속해 주세요');
      expect(log).not.toContain('my-secret-pw');
      expect(JSON.stringify(state.received)).not.toContain('my-secret-pw');
    } finally {
      await h.stop();
    }
  });

  it('streams the state and a base64 frame while the page is open', async () => {
    const state: { hub?: LiveHub; live?: FakeLive; received: IncomingMessage[] } = { received: [] };
    const h = await startApp({ plugins: [livePlugin(state)] });
    const abort = new AbortController();
    try {
      const { token } = await pairApp(h);
      state.hub?.offer('https://example.com/login', 'login');
      await state.hub?.start();
      const response = await fetch(`${h.base}/m/v1/app/browser-live/stream`, {
        headers: { authorization: `Bearer ${token}` },
        signal: abort.signal,
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body?.getReader();
      let text = '';
      while (reader !== undefined && !text.includes('event: frame')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += Buffer.from(chunk.value).toString('utf8');
      }
      expect(text).toContain('event: state');
      const frameLine = text.split('\n').find((line, index, all) => all[index - 1] === 'event: frame' && line.startsWith('data: '));
      const payload = JSON.parse(frameLine?.slice(6) ?? '{}') as Record<string, unknown>;
      expect(payload).toMatchObject({ seq: 1, width: 824, height: 1720, url: 'https://example.com/login', jpeg: JPEG.toString('base64') });
    } finally {
      abort.abort();
      await h.stop();
    }
  });
});
