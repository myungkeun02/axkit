import { describe, expect, it } from 'vitest';
import { MessageRouter } from '../../src/core/conversation/router.js';
import type { IncomingMessage, MessageHandler, OutgoingMessage, Replier } from '../../src/core/conversation/types.js';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { createLogger } from '../../src/core/log/console-logger.js';

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'c1', address: 'a1' },
    authorId: 'owner',
    fromOwner: true,
    text: 'hello',
    receivedAt: new Date('2026-03-08T00:00:00Z'),
    ...overrides,
  };
}

function handler(id: string, priority: number, result: 'handled' | 'pass', calls: string[]): MessageHandler {
  return {
    id,
    priority,
    handle: async () => {
      calls.push(id);
      return result;
    },
  };
}

function setup(handlers: MessageHandler[], failureText = 'Something went wrong.') {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
  const replies: { text: string }[] = [];
  const replier: Replier = {
    reply: async (_to, outgoing: OutgoingMessage) => {
      replies.push({ text: outgoing.text });
    },
  };
  const bus = new InMemoryEventBus(log);
  const router = new MessageRouter({
    handlers: () => handlers,
    replier: () => replier,
    log,
    failureText,
  });
  router.attach(bus);
  return { bus, lines, replies };
}

describe('MessageRouter', () => {
  it('ignores non-owner messages without replying', async () => {
    const calls: string[] = [];
    const { bus, replies, lines } = setup([handler('fallback', 0, 'handled', calls)]);

    await bus.emit('message.received', message({ fromOwner: false }));
    expect(calls).toEqual([]);
    expect(replies).toEqual([]);
    expect(lines.some((line) => line.includes('ignoring non-owner message'))).toBe(true);
  });

  it('tries handlers by priority descending and stops when handled', async () => {
    const calls: string[] = [];
    const { bus, replies } = setup([
      handler('low', 1, 'handled', calls),
      handler('high', 10, 'pass', calls),
    ]);

    await bus.emit('message.received', message());
    expect(calls).toEqual(['high', 'low']);
    expect(replies).toEqual([]);
  });

  it('sends failure text when a handler throws and stops', async () => {
    const calls: string[] = [];
    const throwing: MessageHandler = {
      id: 'broken',
      priority: 100,
      handle: async () => {
        calls.push('broken');
        throw new Error('kaboom');
      },
    };
    const { bus, replies, lines } = setup([throwing, handler('after', 1, 'handled', calls)]);

    await bus.emit('message.received', message());
    expect(calls).toEqual(['broken']);
    expect(replies).toEqual([{ text: 'Something went wrong.' }]);
    expect(lines.some((line) => line.includes('message handler failed') && line.includes('kaboom'))).toBe(true);
  });

  it('logs when no handler handles the message', async () => {
    const calls: string[] = [];
    const { bus, replies, lines } = setup([handler('only', 1, 'pass', calls)]);

    await bus.emit('message.received', message());
    expect(calls).toEqual(['only']);
    expect(replies).toEqual([]);
    expect(lines.some((line) => line.includes('no handler handled the message'))).toBe(true);
  });

  it('does nothing when no handlers are registered', async () => {
    const { bus, replies, lines } = setup([]);

    await bus.emit('message.received', message());
    expect(replies).toEqual([]);
    expect(lines.some((line) => line.includes('no message handlers registered'))).toBe(true);
  });

  it('unsubscribes from the bus', async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const bus = new InMemoryEventBus(log);
    const router = new MessageRouter({
      handlers: () => [handler('only', 1, 'handled', calls)],
      replier: () => undefined,
      log,
      failureText: 'x',
    });
    const unsubscribe = router.attach(bus);
    unsubscribe();

    await bus.emit('message.received', message());
    expect(calls).toEqual([]);
  });
});
