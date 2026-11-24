import { describe, expect, it } from 'vitest';
import { PendingMessages } from '../../src/core/conversation/pending.js';
import { MessageRouter } from '../../src/core/conversation/router.js';
import type { IncomingMessage, MessageHandler } from '../../src/core/conversation/types.js';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { catchUp } from '../../src/channels/discord/plugin.js';
import type { DiscordInbound, DiscordPort } from '../../src/channels/discord/port.js';
import { overlap } from '../../src/skills/assistant/loop.js';
import { createTestContext } from '../support/context.js';
import { MapKeyValueStore } from './helpers.js';

const NOW = new Date('2026-11-23T09:00:00Z');

function message(id: string, at = NOW): IncomingMessage {
  return { id, conversation: { channelId: 'channel.app', address: 'owner' }, authorId: 'owner', fromOwner: true, text: `질문 ${id}`, receivedAt: at };
}

function router(kv: MapKeyValueStore, handler: MessageHandler) {
  return new MessageRouter({ handlers: () => [handler], replier: () => ({ reply: async () => undefined }), log: silentLogger, failureText: 'x', pending: new PendingMessages(kv), lateNote: '(늦게 답해요) ' });
}

describe('messages a restart dropped', () => {
  it('answers a turn the last run never finished, once, with a late note', async () => {
    const kv = new MapKeyValueStore();
    // the first run starts a turn and dies inside it
    await new PendingMessages(kv).begin(message('m1'));
    await new PendingMessages(kv).begin(message('old', new Date(NOW.getTime() - 13 * 3_600_000)));
    const seen: string[] = [];
    const next = router(kv, { id: 'h', priority: 1, handle: async (incoming) => (seen.push(incoming.text), 'handled') });
    const bus = new InMemoryEventBus(silentLogger);
    next.attach(bus);
    expect(await next.recover(NOW)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['(늦게 답해요) 질문 m1']);
    // the channel's own catch-up bringing it back again is not answered twice
    await bus.emit('message.received', message('m1'));
    expect(seen).toHaveLength(1);
    expect(await next.recover(NOW)).toBe(0);
  });

  it('lets go of a message that already broke a turn twice', async () => {
    const kv = new MapKeyValueStore();
    const pending = new PendingMessages(kv);
    await pending.begin(message('m1'));
    await pending.begin(message('m1'));
    expect(await pending.takeForRecovery(NOW)).toEqual([]);
  });
});

describe('Discord catch-up', () => {
  it('hands over the owner’s DMs that came after the last bot message, once', async () => {
    const at = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
    const dm = (id: string, author: string, minutes: number, bot = false): DiscordInbound => ({ id, channelId: 'dm', authorId: author, authorIsBot: bot, isDm: true, content: `글 ${id}`, createdAt: at(minutes) });
    const port = { recent: async () => [dm('d3', 'owner', 1), dm('d2', 'owner', 5), dm('b1', 'bot', 30, true), dm('d1', 'owner', 40)] } as unknown as DiscordPort;
    const context = createTestContext({ now: NOW });
    const received: IncomingMessage[] = [];
    context.bus.on('message.received', (incoming) => void received.push(incoming));
    expect(await catchUp(context.ctx, port, async () => 'dm', 'owner')).toBe(2);
    expect(received.map((incoming) => incoming.text)).toEqual(['(제가 꺼져 있는 동안 보내신 메시지예요. 늦게 답해요) 글 d2', '(제가 꺼져 있는 동안 보내신 메시지예요. 늦게 답해요) 글 d3']);
    expect(await catchUp(context.ctx, port, async () => 'dm', 'owner')).toBe(0);
  });
});

describe('no repeated answers', () => {
  it('scores near-copies high and new answers low', () => {
    expect(overlap('견적서는 내일 오전까지 보내드릴게요.', '견적서는 내일 오전까지 보내드릴게요!')).toBe(1);
    expect(overlap('견적서는 내일 보내드릴게요.', '회의는 목요일 3시로 잡았어요.')).toBeLessThan(0.3);
  });
});

describe('a turn that would repeat itself', () => {
  it('asks the model once more when the reply copies the previous one', async () => {
    const { runTurn } = await import('../../src/skills/assistant/loop.js');
    const { MemoryStore } = await import('../../src/skills/assistant/memory.js');
    const { assistantTexts } = await import('../../src/skills/assistant/locale.js');
    const { ScriptedLlm } = await import('../support/context.js');
    const plan = (reply: string): string => JSON.stringify({ reply, tool_calls: [], question: null, notes: null });
    const same = '견적서는 내일 오전까지 보내드릴게요. 필요한 게 있으면 말씀해 주세요.';
    const llm = new ScriptedLlm([plan(same), plan('네, 회의는 목요일 3시로 잡아 둘게요.')]);
    const context = createTestContext({ now: NOW, llm });
    const memory = new MemoryStore({ kv: new MapKeyValueStore(), llm, clock: context.clock, log: silentLogger, historyTurns: 10 });
    const ref = { channelId: 'channel.app', address: 'owner' };
    await memory.append(ref, '견적서 언제 와?', same);
    const out = await runTurn({ ...message('m2'), text: '그럼 회의는 목요일 3시 괜찮아?' }, { llm, tools: context.ctx.tools, memory, log: silentLogger, texts: assistantTexts('ko'), systemPrompt: 's', maxSteps: 3 });
    expect(out.reply.text).toBe('네, 회의는 목요일 3시로 잡아 둘게요.');
    expect(llm.requests.at(-1)?.messages.at(-1)?.content).toContain('Do not repeat yourself');
  });
});
