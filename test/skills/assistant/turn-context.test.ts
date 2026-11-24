import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Bot, BotTeam } from '../../../src/core/contracts/bots.js';
import { PendingMessages } from '../../../src/core/conversation/pending.js';
import { MessageRouter } from '../../../src/core/conversation/router.js';
import type { CompletedTool, IncomingMessage, OutgoingMessage } from '../../../src/core/conversation/types.js';
import { InMemoryEventBus } from '../../../src/core/events/bus.js';
import type { LlmGateway, LlmRequest, LlmResponse } from '../../../src/core/llm/types.js';
import { LlmError } from '../../../src/core/llm/types.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { assistantSkill } from '../../../src/skills/assistant/plugin.js';
import { MemoryStore } from '../../../src/skills/assistant/memory.js';
import { OWNER_THREAD_REF } from '../../../src/core/conversation/thread.js';
import { MapKeyValueStore, flush } from '../../core/helpers.js';
import { ScriptedLlm, createTestContext } from '../../support/context.js';
import { TEMPLATE, makeHarness, noteTool, plan } from './helpers.js';

const TEAM: BotTeam = { id: 'team-shop', group: 'home', name: 'Shop', kind: 'general', tiers: { lead: 'A', staff: 'B' }, lead: 'shop-lead', createdAt: '2026-11-19T00:00:00Z' };

function member(id: string, rank: Bot['rank'], group?: string): Bot {
  return { id, name: id, role: '쇼핑', kind: 'general', status: 'idle', origin: 'owner', rank, team: TEAM.id, ...(group !== undefined ? { group } : {}), createdAt: '2026-11-19T00:00:00Z' } as Bot;
}

const assign = (staff: number[]): string => JSON.stringify({ assignments: staff.map((n) => ({ staff: n, task: `일 ${n}`, say: `${n}번 부탁해요.` })) });

function room(text: string, address = 'bot:team-shop', id = 'm1'): IncomingMessage {
  return { id, conversation: { channelId: 'channel.app', address }, authorId: 'owner', fromOwner: true, text, receivedAt: new Date('2026-11-23T09:00:00Z') };
}

async function teamSetup(script: (string | ((req: LlmRequest) => string))[]) {
  const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date('2026-11-19T00:00:00Z'));
  await directory.upsertGroup({ id: 'home', label: 'Home' });
  await directory.upsertTeam(TEAM);
  for (const bot of [member('shop-lead', 'lead', 'home'), member('shop-s1', 'staff', 'home')]) await directory.upsert(bot);
  const llm = new ScriptedLlm(script);
  const test = createTestContext({ llm, capabilities: { 'bots.directory': directory } });
  await assistantSkill({ loadSystemPrompt: async () => TEMPLATE }).setup(test.ctx);
  test.ctx.registerTool(noteTool().tool);
  const handler = test.handlers[0];
  if (handler === undefined) throw new Error('no handler');
  return { llm, test, handler };
}

describe('team turns keep the owner’s turn checkpoints', () => {
  it('records each staff tool under the member’s id in the owner’s turn', async () => {
    const { handler } = await teamSetup([assign([1]), plan('', [{ name: 'notes.add', args: { text: '우유' } }]), plan('적었어요.'), '팀이 적어 뒀어요.']);
    const done: CompletedTool[] = [];
    await handler.handle(room('우유 적어 줘'), { reply: async () => undefined }, { onToolDone: (tool) => void done.push(tool) });
    expect(done).toEqual([expect.objectContaining({ name: 'shop-s1/notes.add', effects: ['write'], message: 'saved=우유' })]);
  });

  it('tells the member what it already did when a restart replays the team turn', async () => {
    const { handler, llm } = await teamSetup([assign([1]), plan('이미 적었어요.'), '팀이 적어 뒀어요.']);
    await handler.handle(room('우유 적어 줘'), { reply: async () => undefined }, { resumed: [{ name: 'shop-s1/notes.add', effects: ['write'], message: 'saved=우유' }] });
    const staff = llm.requests.find((request) => request.purpose === 'bot.shop-s1');
    const last = staff?.messages.at(-1)?.content ?? '';
    expect(last).toContain('done_before_restart');
    expect(last).toContain('"tool":"notes.add"');
  });
});

describe('a meeting room', () => {
  it('starts the meeting in the background and passes the owner’s next line straight to it', async () => {
    const group = 'home';
    let speak: () => void = () => undefined;
    const spoken = new Promise<void>((resolve) => (speak = resolve));
    const heard: string[] = [];
    // a model whose first meeting line waits until the owner has spoken
    const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date('2026-11-19T00:00:00Z'));
    await directory.upsertGroup({ id: group, label: 'Home' });
    await directory.upsertTeam(TEAM);
    await directory.upsert(member('shop-lead', 'lead', group));
    const llm: LlmGateway = {
      complete: async (request: LlmRequest): Promise<LlmResponse> => {
        heard.push(request.messages.at(-1)?.content ?? '');
        if (heard.length === 1) await spoken;
        return { text: '다음 주에 할 수 있어요.', providerId: 'f', model: 'f', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      },
    };
    const test = createTestContext({ llm, capabilities: { 'bots.directory': directory } });
    await assistantSkill({ loadSystemPrompt: async () => TEMPLATE }).setup(test.ctx);
    const meeting = test.handlers[0];
    const replies: string[] = [];
    const replier = { reply: async (_to: unknown, out: OutgoingMessage) => void replies.push(out.text) };
    await meeting?.handle(room('다음 주 일정 정해요', 'bot:meet-home', 'r1'), replier);
    expect(replies).toEqual(['팀장회의를 시작할게요. 회의 중에 하실 말씀은 여기에 쓰시면 바로 전할게요.']);
    await meeting?.handle(room('결제 화면 먼저요', 'bot:meet-home', 'r2'), replier);
    expect(replies.at(-1)).toBe('회의에 전했어요.');
    speak();
    for (let i = 0; i < 10; i += 1) await flush();
    // the next speaker heard it, and no second meeting was opened on that line
    expect(heard.slice(1).some((content) => content.includes('owner: 결제 화면 먼저요'))).toBe(true);
    expect(heard.filter((content) => content.includes('<data kind="topic">') && content.includes('결제 화면 먼저요') && !content.includes('다음 주 일정'))).toEqual([]);
  });
});

describe('routine turns report how they ended', () => {
  it('counts a turn that ran tools and then stopped as partial, not done', async () => {
    const note = noteTool();
    const fail = (): string => {
      throw new LlmError('provider_failed', 'down');
    };
    const harness = await makeHarness({ script: [plan('', [{ name: 'notes.add', args: { text: '우유' } }]), fail] });
    harness.ctx.registerTool(note.tool);
    const runner = harness.test.provided.get(Contracts.assistantRunner.id) as { run: (input: { text: string; source: string }) => Promise<{ ok: boolean; status?: string; reason?: string }> };
    const result = await runner.run({ text: '우유 적어 줘', source: 'routine:r1' });
    expect(result).toMatchObject({ ok: false, status: 'partial', reason: 'provider_down' });
  });

  it('counts an answered turn as completed', async () => {
    const harness = await makeHarness({ script: [plan('다 했어요.')] });
    const runner = harness.test.provided.get(Contracts.assistantRunner.id) as { run: (input: { text: string; source: string }) => Promise<{ ok: boolean; status?: string }> };
    expect(await runner.run({ text: '정리해 줘', source: 'routine:r1' })).toMatchObject({ ok: true, status: 'completed' });
  });
});

describe('compaction after the turn', () => {
  it('finishes the pending entry first and does not hold the next owner message', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pendingKv = new MapKeyValueStore();
    const atSummary: unknown[] = [];
    const replies = new ScriptedLlm([plan('첫 답'), plan('둘째 답'), plan('셋째 답')]);
    const llm: LlmGateway = {
      complete: async (request) => {
        if (request.purpose !== 'assistant.summary') return await replies.complete(request);
        atSummary.push(await pendingKv.get('pending'));
        await gate;
        return { text: '요약', providerId: 'f', model: 'f', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      },
    };
    const test = createTestContext({ llm, config: { historyTurns: 1 } });
    await assistantSkill({ loadSystemPrompt: async () => TEMPLATE }).setup(test.ctx);
    const delivered: string[] = [];
    const router = new MessageRouter({ handlers: () => test.handlers, replier: () => ({ reply: async (_to, out) => void delivered.push(out.text) }), log: silentLogger, failureText: 'x', pending: new PendingMessages(pendingKv) });
    const bus = new InMemoryEventBus(silentLogger);
    router.attach(bus);
    const owner = { channelId: 'channel.app', address: 'owner' };
    await bus.emit('message.received', { ...room('첫 메시지', 'owner', 'o1'), conversation: owner });
    await bus.emit('message.received', { ...room('둘째 메시지', 'owner', 'o2'), conversation: owner });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(atSummary).toEqual([[]]);
    // the summary still runs; the next message is answered anyway
    await bus.emit('message.received', { ...room('셋째 메시지', 'owner', 'o3'), conversation: owner });
    expect(delivered).toEqual(['첫 답', '둘째 답', '셋째 답']);
    release();
    for (let i = 0; i < 5; i += 1) await flush();
  });
});

describe('a follow-up from the owner’s Discord DM', () => {
  it('keeps the owner thread, and gives it back to items stored without it', async () => {
    const answered = { status: 'answered', choice: 'yes', means: 'approved', reused: false } as const;
    const test = createTestContext({ now: new Date('2026-11-23T09:00:00Z'), capabilities: { [Contracts.questions.id]: { ask: async () => answered } } });
    await test.kv.set('open-loops', [{ id: 'oabc123', text: '견적 회신', proposal: '초안 쓰기', conversation: { channelId: 'channel.discord', address: 'dm-1' }, createdAt: '2026-11-21T09:00:00Z', status: 'open' }]);
    const { OpenLoops } = await import('../../../src/skills/assistant/open-loops.js');
    const loops = new OpenLoops(test.ctx);
    const received: IncomingMessage[] = [];
    test.bus.on('message.received', (incoming) => void received.push(incoming));
    await loops.add({ channelId: 'channel.discord', address: 'dm-1', thread: 'owner' }, [{ text: '새 일', proposal: '하기' }]);
    const stored = z.array(z.object({ conversation: z.object({ thread: z.string().optional() }) })).parse(await test.kv.get('open-loops'));
    expect(stored.map((item) => item.conversation.thread)).toEqual(['owner', 'owner']);
    expect(await loops.followUp(true)).toBe(1);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received.map((incoming) => incoming.conversation)).toEqual([{ channelId: 'channel.discord', address: 'dm-1', thread: 'owner' }]);
  });
});

describe('compaction and a migration at the same time', () => {
  it('builds the summary again when a migration changed it meanwhile, so the migrated summary is kept', async () => {
    const kv = new MapKeyValueStore();
    const DM = { channelId: 'channel.discord', address: 'dm-1', thread: 'owner' };
    const at = (n: number): string => new Date(Date.UTC(2026, 10, 23, 0, n)).toISOString();
    await kv.set('conv:thread:owner', { summary: 'DM 요약', turns: [0, 1, 2, 3].map((n) => ({ role: n % 2 === 0 ? 'owner' : 'assistant', text: `줄 ${n}`, at: at(n) })), refs: [], migrated: ['conv:channel.discord:dm-1'] });
    // the app's old per-channel memory, not folded into the thread yet
    await kv.set('conv:channel.app:owner', { summary: '앱에서 정한 것', turns: [], refs: [] });
    const holder: { memory?: MemoryStore } = {};
    const llm = new ScriptedLlm([
      () => {
        // a notice lands while the first summary is being written: it migrates the app memory into the thread
        void holder.memory?.notice(OWNER_THREAD_REF, '회의가 10분 뒤예요');
        return '낡은 요약';
      },
      (request) => (request.messages.at(-1)?.content.includes('앱에서 정한 것') === true ? '합친 요약' : '빠진 요약'),
    ]);
    const test = createTestContext({ llm });
    const memory = new MemoryStore({ kv, llm, clock: test.clock, log: silentLogger, historyTurns: 1 });
    holder.memory = memory;
    await memory.compact(DM);
    const stored = (await kv.get<{ summary: string; turns: { text: string }[] }>('conv:thread:owner')) ?? { summary: '', turns: [] };
    expect(stored.summary).toBe('합친 요약');
    expect(stored.turns.some((turn) => turn.text.includes('회의가 10분 뒤예요'))).toBe(true);
    expect(llm.requests).toHaveLength(2);
  });
});
