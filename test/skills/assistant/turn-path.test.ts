import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { CompletedTool, OutgoingMessage } from '../../../src/core/conversation/types.js';
import { LlmError } from '../../../src/core/llm/types.js';
import type { LlmRequest } from '../../../src/core/llm/types.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { assistantTexts } from '../../../src/skills/assistant/locale.js';
import { MemoryStore } from '../../../src/skills/assistant/memory.js';
import { keepRefs, refsOf } from '../../../src/skills/assistant/tool-refs.js';
import { ScriptedLlm } from '../../support/context.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';
import { makeHarness, message, noteTool, plan, run } from './helpers.js';

const KO = assistantTexts('ko');
const APP = { channelId: 'channel.app', address: 'owner', thread: 'owner' };
const DM = { channelId: 'channel.discord', address: 'dm-1', thread: 'owner' };
const THREAD_KEY = 'conv:thread:owner';

interface Stored {
  summary: string;
  turns: { role: string; text: string }[];
  refs: { lines: string[] }[];
}

function fail(code: LlmError['code'], text = 'x'): () => string {
  return () => {
    throw new LlmError(code, text);
  };
}

function searchTool() {
  return {
    name: 'mail.search',
    description: 'Search mail.',
    input: z.object({}),
    effects: ['read' as const],
    run: async () => ({ mails: [{ id: 'mail-a', subject: '견적 요청', from: 'kim@example.com' }, { id: 'mail-b', subject: '회의 일정', from: 'lee@example.com' }] }),
  };
}

describe('a turn that fails after tools ran', () => {
  it('answers from the tool results and remembers that answer', async () => {
    const note = noteTool();
    const harness = await makeHarness({ script: [plan('', [{ name: 'notes.add', args: { text: '우유 사기' } }]), fail('provider_failed')] });
    harness.ctx.registerTool(note.tool);
    const { replies } = await run(harness.handler, '우유 사기 메모해줘');
    const text = replies[0]?.text ?? '';
    expect(text).toContain(KO.partialHead);
    expect(text).toContain('notes.add');
    expect(text).toContain(KO.providerFailed);
    const stored = await harness.test.kv.get<Stored>('conv:c1:a1');
    expect(stored?.turns.at(-1)?.text).toBe(text);
  });

  it('asks again with a larger limit when the plan was cut off', async () => {
    const harness = await makeHarness({ script: ['{"reply": "아주 긴 답이 여기서 끊', plan('긴 답을 끝까지 했어요.')] });
    const { replies } = await run(harness.handler, '길게 설명해줘');
    expect(replies).toEqual([{ text: '긴 답을 끝까지 했어요.' }]);
    expect(harness.llm.requests[0]?.maxOutputTokens).toBe(2500);
    expect(harness.llm.requests[1]?.maxOutputTokens).toBe(6000);
    expect(harness.llm.requests[1]?.messages).toEqual(harness.llm.requests[0]?.messages);
  });

  it('does not blame the owner when the plan is unusable', () => {
    expect(KO.invalidPlan).not.toContain('이해하지');
    expect(KO.invalidPlan).toContain('제가');
  });

  it('says the monthly budget ran out, not the daily one', async () => {
    const harness = await makeHarness({ script: [fail('over_budget', 'Monthly budget of $30 reached (spent $30.1000)')] });
    const { replies } = await run(harness.handler, '안녕');
    expect(replies).toEqual([{ text: KO.overBudgetMonthly }]);
    expect(KO.overBudgetMonthly).not.toContain('내일');
  });
});

describe('a turn replayed after a restart', () => {
  it('tells the model what already ran and says it was cut off', async () => {
    const harness = await makeHarness({ script: [plan('나머지도 정리했어요.')] });
    const resumed: CompletedTool[] = [{ name: 'mail.send', effects: ['send'], message: 'messageId: m-1' }];
    const replies: OutgoingMessage[] = [];
    await harness.handler.handle(message('메일 보내고 정리해줘'), { reply: async (_to, out) => void replies.push(out) }, { resumed });
    expect(replies[0]?.text).toBe(`${KO.resumed} 나머지도 정리했어요.`);
    const last = harness.llm.requests[0]?.messages.at(-1)?.content ?? '';
    expect(last).toContain('done_before_restart');
    expect(last).toContain('mail.send');
    expect(last).toContain('Do not run them again');
  });

  it('reports each finished tool to the router', async () => {
    const note = noteTool();
    const harness = await makeHarness({ script: [plan('', [{ name: 'notes.add', args: { text: '우유' } }]), plan('저장했어요.')] });
    harness.ctx.registerTool(note.tool);
    const done: CompletedTool[] = [];
    await harness.handler.handle(message('메모해줘'), { reply: async () => undefined }, { onToolDone: (tool) => void done.push(tool) });
    expect(done).toEqual([{ name: 'notes.add', effects: ['write'], message: 'saved=우유', args: '{"text":"우유"}' }]);
  });
});

describe('conversation memory', () => {
  it('folds old turns into the summary only after the reply went out', async () => {
    const order: string[] = [];
    const harness = await makeHarness({ script: [plan('첫 답'), plan('둘째 답'), () => (order.push('summary'), '요약')], config: { historyTurns: 1 } });
    const replier = { reply: async () => void order.push('reply') };
    const later: (() => Promise<void>)[] = [];
    const context = { afterTurn: (work: () => Promise<void>) => void later.push(work) };
    await harness.handler.handle(message('첫 메시지'), replier, context);
    await harness.handler.handle(message('둘째 메시지'), replier, context);
    // the summary is not part of the turn: it waits until the router says the turn is over
    expect(order).toEqual(['reply', 'reply']);
    for (const work of later) await work();
    expect(order).toEqual(['reply', 'reply', 'summary']);
  });

  it('keeps turns appended while a summary was being written, and the older ones when it comes back empty', async () => {
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm = new ScriptedLlm(['', () => '요약']);
    const slow = { complete: async (request: LlmRequest) => (request.purpose === 'assistant.summary' && llm.requests.length === 1 ? await waiting : undefined, llm.complete(request)) };
    const memory = new MemoryStore({ kv: new MapKeyValueStore(), llm: slow, clock: new FakeClock(0), log: silentLogger, historyTurns: 1 });
    const ref = { channelId: 'c', address: 'a' };
    await memory.append(ref, 'q1', 'a1');
    await memory.append(ref, 'q2', 'a2');
    // the empty summary keeps everything
    await memory.compact(ref);
    expect((await memory.load(ref)).turns).toHaveLength(4);
    // the next one is slow, and a turn lands meanwhile
    const compacting = memory.compact(ref);
    await memory.append(ref, 'q3', 'a3');
    release();
    await compacting;
    const after = await memory.load(ref);
    expect(after.summary).toBe('요약');
    expect(after.turns.map((turn) => turn.text)).toEqual(['q2', 'a2', 'q3', 'a3']);
  });

  it('shares one owner thread between the app and the Discord DM', async () => {
    const harness = await makeHarness({ script: [plan('앱에서 답'), plan('디엠에서 답')] });
    await run(harness.handler, '앱에서 물어본 것', { conversation: APP });
    await run(harness.handler, '디엠에서 이어서', { conversation: DM });
    const messages = harness.llm.requests[1]?.messages ?? [];
    expect(messages.some((entry) => entry.content === '앱에서 물어본 것')).toBe(true);
    expect((await harness.test.kv.get<Stored>(THREAD_KEY))?.turns).toHaveLength(4);
    expect(await harness.test.kv.get('conv:channel.discord:dm-1')).toBeUndefined();
  });

  it('folds the old per-channel memory into the thread once', async () => {
    const harness = await makeHarness({ script: [plan('네')] });
    await harness.test.kv.set('conv:channel.app:owner', { summary: '예전 요약', turns: [{ role: 'owner', text: '예전 앱 대화', at: '2026-11-01T00:00:00.000Z' }] });
    await run(harness.handler, '그거 기억해?', { conversation: { channelId: 'channel.app', address: 'owner' } });
    const messages = harness.llm.requests[0]?.messages ?? [];
    expect(messages.some((entry) => entry.content === '예전 앱 대화')).toBe(true);
    expect(messages.some((entry) => entry.content.includes('예전 요약'))).toBe(true);
    expect(await harness.test.kv.get('conv:channel.app:owner')).toBeUndefined();
    expect((await harness.test.kv.get<Stored>(THREAD_KEY))?.turns.map((turn) => turn.text)).toEqual(['예전 앱 대화', '그거 기억해?', '네']);
  });

  it('keeps compact tool references so "the second one" resolves next turn', async () => {
    const harness = await makeHarness({ script: [plan('', [{ name: 'mail.search', args: {} }]), plan('두 통 있어요.'), plan('두 번째 메일에 답장할게요.')] });
    harness.ctx.registerTool(searchTool());
    await run(harness.handler, '메일 찾아줘');
    await run(harness.handler, '두 번째 거 답장해줘');
    const shown = harness.llm.requests[2]?.messages.map((entry) => entry.content).join('\n') ?? '';
    expect(shown).toContain('recent_tool_results');
    expect(shown).toContain('mail.search #2: id=mail-b, subject=회의 일정');
  });

  it('picks ids and titles from a tool’s list, and keeps the last three turns only', () => {
    expect(refsOf('t', [{ id: 1 }, { id: 2 }])).toEqual(['t #1: id=1', 't #2: id=2']);
    expect(refsOf('t', { message: '보냈어요' })).toEqual([]);
    const turns = [1, 2, 3].map((n) => ({ at: `${n}`, lines: [`l${n}`] }));
    expect(keepRefs(turns, { at: '4', lines: ['l4'] }, 3).map((turn) => turn.at)).toEqual(['2', '3', '4']);
    expect(keepRefs(turns, { at: '4', lines: [] }, 3)).toHaveLength(3);
  });
});

describe('proactive notices in the owner thread', () => {
  it('adds a delivered notice as an assistant line, keeping only the last few', async () => {
    const harness = await makeHarness({ script: [plan('네, 그 메일에 답할게요.')] });
    for (let index = 1; index <= 5; index += 1) {
      await harness.test.bus.emit('notice.delivered', { kind: 'mail', text: `새 메일 ${index}번: 견적 요청`, at: '2026-11-17T00:00:00.000Z' });
    }
    const stored = await harness.test.kv.get<Stored>(THREAD_KEY);
    expect(stored?.turns.map((turn) => turn.text)).toEqual(['[알림] 새 메일 3번: 견적 요청', '[알림] 새 메일 4번: 견적 요청', '[알림] 새 메일 5번: 견적 요청']);
    await run(harness.handler, '그거 답장해줘', { conversation: APP });
    const messages = harness.llm.requests[0]?.messages ?? [];
    expect(messages.some((entry) => entry.role === 'assistant' && entry.content.includes('새 메일 5번'))).toBe(true);
  });

  it('cuts a long notice', async () => {
    const harness = await makeHarness({ script: [] });
    await harness.test.bus.emit('notice.delivered', { kind: 'dev', text: '가'.repeat(500), at: '2026-11-17T00:00:00.000Z' });
    const stored = await harness.test.kv.get<Stored>(THREAD_KEY);
    expect(stored?.turns[0]?.text.length).toBe('[알림] '.length + 300);
  });
});

describe('messages still in progress', () => {
  it('shows the model what else the owner asked that is not answered yet', async () => {
    const harness = await makeHarness({ script: [plan('메일 정리는 아직 하고 있어요.')] });
    const inProgress = () => [
      { id: 'a1', text: '메일 다 정리해줘', at: new Date('2026-11-17T00:00:00Z') },
      { id: 'm1', text: '어떻게 됐어?', at: new Date('2026-11-17T00:01:00Z') },
    ];
    await harness.handler.handle(message('어떻게 됐어?'), { reply: async () => undefined }, { inProgress });
    const shown = harness.llm.requests[0]?.messages.map((entry) => entry.content).join('\n') ?? '';
    expect(shown).toContain('owner_messages_in_progress');
    expect(shown).toContain('메일 다 정리해줘');
    expect(shown.match(/어떻게 됐어\?/g)).toHaveLength(1);
  });
});
