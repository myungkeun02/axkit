import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isCancelPhrase } from '../../src/core/conversation/cancel.js';
import { PendingMessages } from '../../src/core/conversation/pending.js';
import { MessageRouter } from '../../src/core/conversation/router.js';
import type { IncomingMessage, MessageHandler, Replier, TurnContext } from '../../src/core/conversation/types.js';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { MemoryAuditLog, silentLogger } from '../../src/core/log/console-logger.js';
import type { ConfirmAnswer, ConfirmOptions, ConfirmRequest, Confirmer } from '../../src/core/policy/types.js';
import { PolicyToolExecutor } from '../../src/core/tools/executor.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { MapKeyValueStore, flush } from './helpers.js';

const NOW = new Date('2026-11-23T09:00:00Z');

function message(id: string, text = `질문 ${id}`, conversation: IncomingMessage['conversation'] = { channelId: 'channel.app', address: 'owner' }): IncomingMessage {
  return { id, conversation, authorId: 'owner', fromOwner: true, text, receivedAt: NOW };
}

function build(handler: MessageHandler, kv = new MapKeyValueStore(), replier: Replier = { reply: async () => undefined }) {
  const pending = new PendingMessages(kv);
  const router = new MessageRouter({ handlers: () => [handler], replier: () => replier, log: silentLogger, failureText: '실패', pending, lateNote: '(늦게) ', retryDelaysMs: [1, 1] });
  const bus = new InMemoryEventBus(silentLogger);
  router.attach(bus);
  return { router, bus, pending, kv };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await flush();
}

/** A card that stays open until answered or closed by the signal. */
class HeldCard implements Confirmer {
  requests: ConfirmRequest[] = [];
  closed = 0;
  private answer: ((value: ConfirmAnswer) => void) | undefined;
  confirm(request: ConfirmRequest, options: ConfirmOptions = {}): Promise<ConfirmAnswer> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.answer = resolve;
      options.signal?.addEventListener('abort', () => {
        this.closed += 1;
        resolve('expired');
      });
    });
  }
  approve(): void {
    this.answer?.('approved');
  }
}

describe('a catch-up that arrives before recovery', () => {
  it('continues the started turn with its finished tools, once', async () => {
    const kv = new MapKeyValueStore();
    const seed = new PendingMessages(kv);
    await seed.begin(message('m1'));
    await seed.toolDone('m1', { name: 'mail.send', effects: ['send'], message: 'messageId: m-1' });
    const runs: (string[] | undefined)[] = [];
    const { router, bus } = build({ id: 'h', priority: 1, handle: async (_m, _r, context) => (runs.push(context?.resumed?.map((tool) => tool.name)), 'handled') }, kv);
    // the Discord catch-up hands the message over first, then recovery runs
    await bus.emit('message.received', message('m1'));
    expect(await router.recover(NOW)).toBe(0);
    await settle();
    expect(runs).toEqual([['mail.send']]);
    expect(await kv.get('pending')).toEqual([]);
  });

  it('only delivers a finished turn’s stored reply instead of running it again', async () => {
    const kv = new MapKeyValueStore();
    const seed = new PendingMessages(kv);
    await seed.begin(message('m1'));
    await seed.undelivered('m1', [{ to: message('m1').conversation, message: { text: '저장된 답' } }]);
    const delivered: string[] = [];
    let ran = 0;
    const { router, bus } = build({ id: 'h', priority: 1, handle: async () => ((ran += 1), 'handled') }, kv, { reply: async (_to, out) => void delivered.push(out.text) });
    await bus.emit('message.received', message('m1'));
    await router.recover(NOW);
    await settle();
    expect(ran).toBe(0);
    expect(delivered).toEqual(['저장된 답']);
    expect(await kv.get('pending')).toEqual([]);
  });

  it('leaves a message recovery already claimed to recovery', async () => {
    const kv = new MapKeyValueStore();
    const seed = new PendingMessages(kv);
    await seed.begin(message('m1'));
    await seed.toolDone('m1', { name: 'mail.send', effects: ['send'], message: 'messageId: m-1' });
    const runs: (string | undefined)[] = [];
    const { router, bus } = build({ id: 'h', priority: 1, handle: async (incoming, _r, context) => (runs.push(`${incoming.text}|${context?.resumed?.length ?? 0}`), 'handled') }, kv);
    expect(await router.recover(NOW)).toBe(1);
    await bus.emit('message.received', message('m1'));
    await settle();
    expect(runs).toEqual(['(늦게) 질문 m1|1']);
  });
});

describe('a turn waiting for the owner', () => {
  it('lets the owner’s next message run while the card waits, then finishes before newer messages', async () => {
    const order: string[] = [];
    let answer: (value: string) => void = () => undefined;
    let releaseA2: () => void = () => undefined;
    const handler: MessageHandler = {
      id: 'h',
      priority: 1,
      handle: async (incoming, _r, context?: TurnContext) => {
        order.push(`start ${incoming.id}`);
        if (incoming.id === 'a1') order.push(`card ${await context!.awaitOwner!(() => new Promise<string>((resolve) => (answer = resolve)))}`);
        if (incoming.id === 'a2') await new Promise<void>((resolve) => (releaseA2 = resolve));
        order.push(`end ${incoming.id}`);
        return 'handled';
      },
    };
    const { bus } = build(handler);
    void bus.emit('message.received', message('a1', '메일 보내줘'));
    await settle();
    void bus.emit('message.received', message('a2', '왜 필요한데?'));
    await settle();
    expect(order).toEqual(['start a1', 'start a2']);
    void bus.emit('message.received', message('a3', '그리고 하나 더'));
    answer('yes');
    await settle();
    // a1 got its answer while a2 runs: it goes next, ahead of a3
    releaseA2();
    await settle();
    expect(order).toEqual(['start a1', 'start a2', 'end a2', 'card yes', 'end a1', 'start a3', 'end a3']);
  });

  it('closes the waiting card as a no when the owner types "취소해", without a turn of its own', async () => {
    const registry = new InMemoryToolRegistry();
    let sent = 0;
    registry.register({ name: 'mail.send', description: 'send', input: z.object({}), effects: ['send'], describe: () => '견적서 보내기', run: async () => ((sent += 1), { ok: true }) });
    const card = new HeldCard();
    const executor = new PolicyToolExecutor({ registry, confirmer: () => card, policy: { confirmWrites: false, expiresMinutes: 30 }, audit: new MemoryAuditLog(), log: silentLogger });
    const seen: string[] = [];
    const handler: MessageHandler = {
      id: 'h',
      priority: 1,
      handle: async (incoming, _r, context) => {
        seen.push(incoming.text);
        if (incoming.id === 'a1') {
          const outcome = await executor.execute('mail.send', {}, { grounding: [], ...(context?.awaitOwner !== undefined ? { awaitOwner: context.awaitOwner } : {}) });
          seen.push(outcome.status);
        }
        return 'handled';
      },
    };
    const { bus, kv } = build(handler);
    void bus.emit('message.received', message('a1', '견적서 보내줘'));
    await settle();
    // from the owner's Discord DM, the same owner thread
    void bus.emit('message.received', message('a2', '취소해', { channelId: 'channel.discord', address: 'dm-1', thread: 'owner' }));
    await settle();
    expect(seen).toEqual(['견적서 보내줘', 'denied']);
    expect(card.closed).toBe(1);
    expect(sent).toBe(0);
    expect(await kv.get('pending')).toEqual([]);
  });

  it('lets a turn that runs while a card waits see what that card asks', async () => {
    const registry = new InMemoryToolRegistry();
    registry.register({ name: 'mail.send', description: 'send', input: z.object({}), effects: ['send'], describe: () => '견적서 보내기', run: async () => ({ ok: true }) });
    const card = new HeldCard();
    const executor = new PolicyToolExecutor({ registry, confirmer: () => card, policy: { confirmWrites: false, expiresMinutes: 30 }, audit: new MemoryAuditLog(), log: silentLogger });
    const awaiting: (readonly string[])[] = [];
    const handler: MessageHandler = {
      id: 'h',
      priority: 1,
      handle: async (incoming, _r, context) => {
        if (incoming.id === 'a1') await executor.execute('mail.send', {}, { grounding: [], ...(context?.awaitOwner !== undefined ? { awaitOwner: context.awaitOwner } : {}) });
        else awaiting.push(context?.awaiting?.() ?? []);
        return 'handled';
      },
    };
    const { bus } = build(handler);
    void bus.emit('message.received', message('a1', '견적서 보내줘'));
    await settle();
    void bus.emit('message.received', message('a2', '그거 왜 필요해?'));
    await settle();
    expect(awaiting).toEqual([[expect.stringContaining('견적서 보내기')]]);
  });

  it('answers a cancellation phrase as a normal message when nothing waits', async () => {
    const seen: string[] = [];
    const { bus } = build({ id: 'h', priority: 1, handle: async (incoming) => (seen.push(incoming.text), 'handled') });
    await bus.emit('message.received', message('a1', '취소해'));
    expect(seen).toEqual(['취소해']);
  });

  it('tells a cancellation from a question', () => {
    for (const text of ['취소해', '취소해 줘!', '그거 취소', '하지 마', '그만', 'cancel', 'Never mind.']) expect(isCancelPhrase(text)).toBe(true);
    for (const text of ['왜 필요한데?', '취소 수수료는 얼마야?', '그만큼 보내 줘', '']) expect(isCancelPhrase(text)).toBe(false);
  });
});
