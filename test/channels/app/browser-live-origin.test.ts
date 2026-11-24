import { describe, expect, it } from 'vitest';
import { continueTarget } from '../../../src/channels/app/browser-live-done.js';
import type { BrowserAgent, LiveBrowser } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { IncomingMessage, OutgoingMessage } from '../../../src/core/conversation/types.js';
import type { Plugin } from '../../../src/core/plugin/types.js';
import { Caps } from '../../../src/core/plugin/types.js';
import { LiveHub } from '../../../src/skills/browser/live-hub.js';
import { api, events, pairApp, startApp, until } from './harness.js';

const LIVE: LiveBrowser = {
  frame: async () => ({ jpeg: Buffer.from([0xff, 0xd8]), width: 824, height: 1720, url: 'https://shop.example.com/login', title: '' }),
  tap: async () => undefined,
  type: async () => undefined,
  key: async () => undefined,
  scroll: async () => undefined,
  back: async () => undefined,
  close: async () => undefined,
};

interface State {
  hub?: LiveHub;
  received: IncomingMessage[];
  discord: OutgoingMessage[];
  /** How many Discord lines were already posted when the "carry on" reached the assistant. */
  discordAtHandoff?: number;
}

/** A live hub, a stand-in Discord channel, and a handler that answers "핸드오프" with a reply carrying `live`. */
function testPlugin(state: State, withDiscord: boolean): Plugin {
  const agent: BrowserAgent = {
    label: 'fake',
    read: async () => ({ status: 'done', summary: '' }),
    run: async () => ({ status: 'done', summary: '' }),
    openLive: async () => LIVE,
  };
  return {
    manifest: { id: 'skill.test-live-origin', kind: 'skill', title: 'live origin' },
    setup(ctx) {
      state.hub = new LiveHub({ agent, clock: ctx.clock, log: ctx.log, killSwitch: () => undefined });
      ctx.provide(Contracts.browserLive, state.hub);
      if (withDiscord) {
        ctx.use(Caps.channels).register({
          id: 'channel.discord',
          replier: { reply: async (_to, message) => void state.discord.push(message) },
          owner: { send: async () => undefined },
        });
      }
      ctx.bus.on('message.received', (message) => {
        state.received.push(message);
        state.discordAtHandoff ??= state.discord.length;
      });
      ctx.registerHandler({
        id: 'test.live',
        priority: 100,
        handle: async (message, replier) => {
          if (message.text !== '핸드오프') return 'pass';
          await replier.reply(message.conversation, {
            text: '로그인 화면에서 멈췄어요.',
            live: { view: 'browser-live', reason: 'login', url: 'https://shop.example.com/login' },
          });
          return 'handled';
        },
      });
    },
  };
}

describe('where "done" continues (§22)', () => {
  it('picks the errand’s own conversation, else the app with a note', () => {
    expect(continueTarget(undefined, [])).toEqual({ kind: 'app', fallback: false });
    expect(continueTarget({ channelId: 'channel.app', address: 'owner' }, ['channel.app'])).toEqual({ kind: 'app', fallback: false });
    expect(continueTarget({ channelId: 'channel.app', address: 'bot:mina' }, [])).toEqual({ kind: 'app', room: 'mina', fallback: false });
    expect(continueTarget({ channelId: 'channel.discord', address: 'dm-1' }, ['channel.discord'])).toEqual({
      kind: 'other',
      conversation: { channelId: 'channel.discord', address: 'dm-1' },
    });
    expect(continueTarget({ channelId: 'channel.discord', address: 'dm-1' }, ['channel.app'])).toEqual({ kind: 'app', fallback: true });
    expect(continueTarget({ channelId: 'core.routines', address: 'routine:1' }, [])).toEqual({ kind: 'app', fallback: true });
    expect(continueTarget({ channelId: 'core.delegation', address: 'bot:mina' }, [])).toEqual({ kind: 'app', room: 'mina', fallback: true });
  });

  it('carries `live` on the assistant message event', async () => {
    const state: State = { received: [], discord: [] };
    const h = await startApp({ plugins: [testPlugin(state, false)] });
    try {
      const { token } = await pairApp(h);
      expect((await api(h, token, 'messages', { text: '핸드오프' })).status).toBeLessThan(300);
      await until(async () => (await events(h, token)).some((event) => event.type === 'message' && event.role === 'assistant'));
      const reply = (await events(h, token)).find((event) => event.type === 'message' && event.role === 'assistant');
      expect(reply).toMatchObject({ text: '로그인 화면에서 멈췄어요.', live: { view: 'browser-live', reason: 'login', url: 'https://shop.example.com/login' } });
      const owner = (await events(h, token)).find((event) => event.type === 'message' && event.role === 'owner');
      expect(owner).not.toHaveProperty('live');
    } finally {
      await h.stop();
    }
  });

  it('continues in the bot room the errand came from', async () => {
    const state: State = { received: [], discord: [] };
    const h = await startApp({ plugins: [testPlugin(state, false)] });
    try {
      const { token } = await pairApp(h);
      state.hub?.offer('https://shop.example.com/login', 'login', { channelId: 'channel.app', address: 'bot:mina', replyTo: 'app:9' });
      const done = (await (await api(h, token, 'views/browser-live/done', {})).json()) as { data: Record<string, unknown> };
      expect(done.data).toMatchObject({ resumed: true, continuedIn: 'app', channel: 'mina' });
      await until(() => state.received.length > 0);
      expect(state.received[0]?.conversation).toMatchObject({ channelId: 'channel.app', address: 'bot:mina' });
      const line = (await events(h, token)).find((event) => event.type === 'message' && event.role === 'owner');
      expect(line).toMatchObject({ channel: 'mina' });
      expect(line?.type === 'message' ? line.text : '').toContain('계속해 주세요');
    } finally {
      await h.stop();
    }
  });

  it('continues in Discord when the errand came from there, and says so in the app', async () => {
    const state: State = { received: [], discord: [] };
    const h = await startApp({ plugins: [testPlugin(state, true)] });
    try {
      const { token } = await pairApp(h);
      state.hub?.offer('https://shop.example.com/login', 'login', { channelId: 'channel.discord', address: 'dm-1', replyTo: 'msg-1' });
      await state.hub?.start();
      const done = (await (await api(h, token, 'views/browser-live/done', {})).json()) as { data: Record<string, unknown> };
      expect(done.data).toMatchObject({ resumed: true, continuedIn: 'elsewhere' });
      await until(() => state.received.length > 0);
      // where to answer only: never a message id to quote
      expect(state.received[0]).toMatchObject({ fromOwner: true, conversation: { channelId: 'channel.discord', address: 'dm-1' } });
      expect(state.received[0]?.conversation.replyTo).toBeUndefined();
      expect(state.received[0]?.text).toContain('shop.example.com');
      // the owner sees a short line in Discord first, through that channel's replier, then the assistant answers there
      expect(state.discord).toEqual([{ text: '(앱의 브라우저 화면에서 직접 마쳤어요: shop.example.com) 이어서 할게요.' }]);
      expect(state.discordAtHandoff).toBe(1);
      const log = await events(h, token);
      expect(log.some((event) => event.type === 'message' && event.role === 'owner')).toBe(false);
      expect(log.find((event) => event.type === 'notice')).toMatchObject({ text: expect.stringContaining('디스코드') as unknown as string });
    } finally {
      await h.stop();
    }
  });

  it('falls back to the app main chat, saying so, when the errand’s channel is not running', async () => {
    const state: State = { received: [], discord: [] };
    const h = await startApp({ plugins: [testPlugin(state, false)] });
    try {
      const { token } = await pairApp(h);
      state.hub?.offer('https://shop.example.com/login', 'login', { channelId: 'core.routines', address: 'routine:morning' });
      const done = (await (await api(h, token, 'views/browser-live/done', {})).json()) as { data: Record<string, unknown> };
      expect(done.data).toMatchObject({ resumed: true, continuedIn: 'app' });
      await until(() => state.received.length > 0);
      expect(state.received[0]?.conversation).toMatchObject({ channelId: 'channel.app', address: 'owner' });
      expect(state.received[0]?.text).toContain('여기서 이어 가요');
    } finally {
      await h.stop();
    }
  });
});
