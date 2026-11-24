import { describe, expect, it } from 'vitest';
import { PendingMessages } from '../../src/core/conversation/pending.js';
import { MessageRouter } from '../../src/core/conversation/router.js';
import { KeyedQueue } from '../../src/core/conversation/turn-queue.js';
import type { IncomingMessage, MessageHandler, OutgoingMessage, Replier, TurnContext } from '../../src/core/conversation/types.js';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { MapKeyValueStore, flush } from './helpers.js';

const NOW = new Date('2026-11-23T09:00:00Z');

function message(id: string, address = 'owner', text = `질문 ${id}`, at = NOW): IncomingMessage {
  return { id, conversation: { channelId: 'channel.app', address }, authorId: 'owner', fromOwner: true, text, receivedAt: at };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function build(handler: MessageHandler, opts: { replier?: Replier; kv?: MapKeyValueStore; delays?: number[] } = {}) {
  const kv = opts.kv ?? new MapKeyValueStore();
  const pending = new PendingMessages(kv);
  const router = new MessageRouter({
    handlers: () => [handler],
    replier: () => opts.replier ?? { reply: async () => undefined },
    log: silentLogger,
    failureText: '실패',
    pending,
    lateNote: '(늦게) ',
    retryDelaysMs: opts.delays ?? [1, 1, 1],
  });
  const bus = new InMemoryEventBus(silentLogger);
  router.attach(bus);
  return { kv, pending, router, bus };
}

describe('one conversation, one turn at a time', () => {
  it('runs turns of the same conversation in arrival order and others side by side', async () => {
    const log: string[] = [];
    const first = gate();
    const handler: MessageHandler = {
      id: 'h',
      priority: 1,
      handle: async (incoming) => {
        log.push(`start ${incoming.id}`);
        if (incoming.id === 'a1') await first.wait;
        log.push(`end ${incoming.id}`);
        return 'handled';
      },
    };
    const { bus } = build(handler);
    void bus.emit('message.received', message('a1'));
    void bus.emit('message.received', message('a2'));
    void bus.emit('message.received', message('b1', 'bot:x'));
    await flush();
    // a2 waits for a1; the other room does not
    expect(log).toEqual(['start a1', 'start b1', 'end b1']);
    first.open();
    await flush();
    expect(log).toEqual(['start a1', 'start b1', 'end b1', 'end a1', 'start a2', 'end a2']);
  });

  it('treats the app main chat and the owner’s Discord DM as one conversation', async () => {
    const order: string[] = [];
    const hold = gate();
    const handler: MessageHandler = {
      id: 'h',
      priority: 1,
      handle: async (incoming) => {
        if (incoming.id === 'app') await hold.wait;
        order.push(incoming.id);
        return 'handled';
      },
    };
    const { bus } = build(handler);
    void bus.emit('message.received', message('app'));
    void bus.emit('message.received', { ...message('dm'), conversation: { channelId: 'channel.discord', address: 'dm-1', thread: 'owner' } });
    await flush();
    expect(order).toEqual([]);
    hold.open();
    await flush();
    expect(order).toEqual(['app', 'dm']);
  });

  it('shows a running turn the messages that arrived after it', async () => {
    const hold = gate();
    let seen: readonly string[] = [];
    const handler: MessageHandler = {
      id: 'h',
      priority: 1,
      handle: async (incoming, _replier, context?: TurnContext) => {
        if (incoming.id === 'a1') {
          await hold.wait;
          seen = (context?.inProgress?.() ?? []).map((item) => item.text);
        }
        return 'handled';
      },
    };
    const { bus } = build(handler);
    void bus.emit('message.received', message('a1', 'owner', '메일 정리해줘'));
    void bus.emit('message.received', message('a2', 'owner', '어떻게 됐어?'));
    await flush();
    hold.open();
    await flush();
    expect(seen).toEqual(['메일 정리해줘', '어떻게 됐어?']);
  });

  it('records a waiting message in the pending list right away', async () => {
    const hold = gate();
    const handler: MessageHandler = { id: 'h', priority: 1, handle: async (incoming) => (incoming.id === 'a1' ? await hold.wait : undefined, 'handled') };
    const { bus, kv } = build(handler);
    void bus.emit('message.received', message('a1'));
    void bus.emit('message.received', message('a2'));
    await flush();
    expect(((await kv.get<{ id: string }[]>('pending')) ?? []).map((item) => item.id)).toEqual(['a1', 'a2']);
    hold.open();
    await flush();
    expect(await kv.get('pending')).toEqual([]);
  });
});

describe('pending entries', () => {
  it('keeps every entry when turns begin at the same time', async () => {
    const pending = new PendingMessages(new MapKeyValueStore());
    await Promise.all([pending.begin(message('m1')), pending.begin(message('m2')), pending.begin(message('m3'))]);
    expect((await pending.takeForRecovery(NOW)).map((item) => item.message.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('does not bring back an entry finished right after it began', async () => {
    const pending = new PendingMessages(new MapKeyValueStore());
    void pending.begin(message('m1'));
    await pending.finish('m1');
    expect(await pending.takeForRecovery(NOW)).toEqual([]);
  });

  it('replays dropped messages oldest first, one after another', async () => {
    const kv = new MapKeyValueStore();
    const seed = new PendingMessages(kv);
    await seed.begin(message('late', 'owner', '둘째', new Date(NOW.getTime() - 1_000)));
    await seed.begin(message('early', 'bot:x', '첫째', new Date(NOW.getTime() - 60_000)));
    const log: string[] = [];
    const handler: MessageHandler = {
      id: 'h',
      priority: 1,
      handle: async (incoming) => {
        log.push(`start ${incoming.id}`);
        await flush();
        log.push(`end ${incoming.id}`);
        return 'handled';
      },
    };
    const { router } = build(handler, { kv });
    expect(await router.recover(NOW)).toBe(2);
    for (let i = 0; i < 6; i += 1) await flush();
    expect(log).toEqual(['start early', 'end early', 'start late', 'end late']);
  });
});

describe('delivery', () => {
  it('keeps the message until its reply is delivered, retrying with a backoff', async () => {
    let failures = 2;
    const delivered: string[] = [];
    const replier: Replier = {
      reply: async (_to, outgoing: OutgoingMessage) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('channel down');
        }
        delivered.push(outgoing.text);
      },
    };
    const handler: MessageHandler = { id: 'h', priority: 1, handle: async (incoming, reply) => (await reply.reply(incoming.conversation, { text: '답이에요' }), 'handled') };
    const { bus, kv } = build(handler, { replier, delays: [5, 5, 5] });
    await bus.emit('message.received', message('m1'));
    const kept = (await kv.get<{ id: string; outbox?: unknown[] }[]>('pending')) ?? [];
    expect(kept.map((item) => [item.id, item.outbox?.length])).toEqual([['m1', 1]]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(delivered).toEqual(['답이에요']);
    expect(await kv.get('pending')).toEqual([]);
  });

  it('delivers a stored reply after a restart without running the turn again', async () => {
    const kv = new MapKeyValueStore();
    const seed = new PendingMessages(kv);
    await seed.begin(message('m1'));
    await seed.undelivered('m1', [{ to: message('m1').conversation, message: { text: '저장된 답' } }]);
    const delivered: string[] = [];
    let ran = 0;
    const { router } = build({ id: 'h', priority: 1, handle: async () => (ran += 1, 'handled') }, { kv, replier: { reply: async (_to, outgoing) => void delivered.push(outgoing.text) } });
    await router.recover(NOW);
    await flush();
    expect(delivered).toEqual(['저장된 답']);
    expect(ran).toBe(0);
    expect(await kv.get('pending')).toEqual([]);
  });
});

describe('a restart in the middle of a turn', () => {
  it('records finished tools and replays with them when one changed something', async () => {
    const kv = new MapKeyValueStore();
    const first = build({ id: 'h', priority: 1, handle: async () => 'handled' }, { kv });
    await first.pending.begin(message('m1'));
    await first.pending.toolDone('m1', { name: 'mail.send', effects: ['send'], message: 'messageId: m-1' });
    let resumed: TurnContext['resumed'];
    const next = build({ id: 'h', priority: 1, handle: async (_incoming, _reply, context) => ((resumed = context?.resumed), 'handled') }, { kv });
    await next.router.recover(NOW);
    await flush();
    expect(resumed?.map((tool) => tool.name)).toEqual(['mail.send']);
  });

  it('replays as before when only reading tools ran', async () => {
    const kv = new MapKeyValueStore();
    const seed = new PendingMessages(kv);
    await seed.begin(message('m1'));
    await seed.toolDone('m1', { name: 'mail.search', effects: ['read'], message: '3' });
    let context: TurnContext | undefined;
    let text = '';
    const { router } = build({ id: 'h', priority: 1, handle: async (incoming, _reply, turn) => ((context = turn), (text = incoming.text), 'handled') }, { kv });
    await router.recover(NOW);
    await flush();
    expect(context?.resumed).toBeUndefined();
    expect(text).toBe('(늦게) 질문 m1');
  });
});

describe('shutdown', () => {
  it('waits for a running turn and keeps a message that arrives meanwhile for the next start', async () => {
    const hold = gate();
    const handler: MessageHandler = { id: 'h', priority: 1, handle: async (incoming) => (incoming.id === 'm1' ? await hold.wait : undefined, 'handled') };
    const { bus, router, pending } = build(handler);
    void bus.emit('message.received', message('m1'));
    await flush();
    const closing = router.close(1_000);
    void bus.emit('message.received', message('m2'));
    hold.open();
    expect(await closing).toBe(true);
    await flush();
    expect((await pending.takeForRecovery(NOW)).map((item) => item.message.id)).toEqual(['m2']);
  });

  it('gives up waiting after the timeout', async () => {
    const handler: MessageHandler = { id: 'h', priority: 1, handle: async () => (await new Promise(() => undefined), 'handled') };
    const { bus, router } = build(handler);
    void bus.emit('message.received', message('m1'));
    await flush();
    expect(await router.close(20)).toBe(false);
  });

  it('a keyed queue reports idle once everything settled', async () => {
    const queue = new KeyedQueue();
    const hold = gate();
    void queue.run('k', () => hold.wait);
    expect(queue.size).toBe(1);
    const idle = queue.idle(1_000);
    hold.open();
    expect(await idle).toBe(true);
    expect(queue.size).toBe(0);
  });
});
