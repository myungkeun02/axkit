import { describe, expect, it } from 'vitest';
import type { Harness } from './helpers.js';
import { makeHarness, plan, run } from './helpers.js';

interface StoredMemory {
  summary: string;
  turns: { role: 'owner' | 'assistant'; text: string; at: string }[];
}

const KEY = 'conv:c1:a1';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz123456';

async function stored(harness: Harness): Promise<StoredMemory | undefined> {
  return await harness.test.kv.get<StoredMemory>(KEY);
}

describe('assistant memory', () => {
  it('appends the owner message and the final reply', async () => {
    const harness = await makeHarness({ script: [plan('네, 알겠습니다.')] });
    await run(harness.handler, '내일 미팅 잡아줘');

    const memory = await stored(harness);
    expect(memory?.summary).toBe('');
    expect(memory?.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ['owner', '내일 미팅 잡아줘'],
      ['assistant', '네, 알겠습니다.'],
    ]);
    expect(memory?.turns[0]?.at).toBe('2026-11-17T00:00:00.000Z');
    expect(harness.test.clock.now().toISOString()).toBe('2026-11-17T00:00:00.000Z');
  });

  it('uses the conversation address for the storage key', async () => {
    const harness = await makeHarness({ script: [plan('네')] });
    await run(harness.handler, '안녕', {
      conversation: { channelId: 'guild-1', address: 'dm-9' },
    });

    expect(await harness.test.kv.get('conv:guild-1:dm-9')).toBeDefined();
    expect(await harness.test.kv.get(KEY)).toBeUndefined();
  });

  it('masks token-like strings before saving', async () => {
    const harness = await makeHarness({ script: [plan(`받았어요 ${TOKEN}`)] });
    await run(harness.handler, `토큰 ${TOKEN} 저장해줘`);

    const memory = await stored(harness);
    for (const turn of memory?.turns ?? []) {
      expect(turn.text).toContain('[가림]');
      expect(turn.text).not.toContain(TOKEN);
    }
  });

  it('sends the saved summary and prior turns as context', async () => {
    const harness = await makeHarness({ script: [plan('네')] });
    await harness.test.kv.set(KEY, {
      summary: '우유를 사기로 했어요.',
      turns: [{ role: 'owner', text: '지난번에 말한 것', at: '2026-11-16T00:00:00.000Z' }],
    });

    await run(harness.handler, '그거 기억해?');

    const messages = harness.llm.requests[0]?.messages ?? [];
    const summary = messages.find((entry) => entry.content.includes('<data kind="memory_summary">'));
    expect(summary?.content).toContain('우유를 사기로 했어요.');
    expect(messages.some((entry) => entry.content === '지난번에 말한 것')).toBe(true);
    expect(messages.at(-1)?.content).toBe('그거 기억해?');
  });

  it('summarizes the oldest half when the history grows past the limit', async () => {
    const harness = await makeHarness({
      script: [plan('첫 답'), plan('둘째 답'), '이전 대화 요약입니다'],
      config: { historyTurns: 1 },
    });

    await run(harness.handler, '첫 메시지');
    await run(harness.handler, '둘째 메시지');

    expect(harness.llm.requests).toHaveLength(3);
    expect(harness.llm.requests[2]?.purpose).toBe('assistant.summary');
    expect(harness.llm.requests[2]?.tier).toBe('fast');
    expect(harness.llm.requests[2]?.sensitivity).toBe('sensitive');
    expect(harness.llm.requests[2]?.jsonSchema).toBeUndefined();
    expect(harness.llm.requests[2]?.messages.at(-1)?.content).toContain('첫 메시지');

    const memory = await stored(harness);
    expect(memory?.summary).toBe('이전 대화 요약입니다');
    expect(memory?.turns.map((turn) => turn.text)).toEqual(['둘째 메시지', '둘째 답']);
  });

  it('merges the previous summary into the summarization request', async () => {
    const harness = await makeHarness({
      script: [plan('첫 답'), plan('둘째 답'), '합친 요약'],
      config: { historyTurns: 1 },
    });
    await harness.test.kv.set(KEY, { summary: '기존 요약', turns: [] });

    await run(harness.handler, '첫 메시지');
    await run(harness.handler, '둘째 메시지');

    expect(harness.llm.requests[2]?.messages.at(-1)?.content).toContain('기존 요약');
    expect((await stored(harness))?.summary).toBe('합친 요약');
  });

  it('keeps the old summary and the older turns when summarization fails', async () => {
    const harness = await makeHarness({
      script: [
        plan('첫 답'),
        plan('둘째 답'),
        () => {
          throw new Error('summary backend down');
        },
      ],
      config: { historyTurns: 1 },
    });
    await harness.test.kv.set(KEY, { summary: '기존 요약', turns: [] });

    await run(harness.handler, '첫 메시지');
    const second = await run(harness.handler, '둘째 메시지');

    expect(second.replies).toEqual([{ text: '둘째 답' }]);
    const memory = await stored(harness);
    expect(memory?.summary).toBe('기존 요약');
    expect(memory?.turns.map((turn) => turn.text)).toEqual(['첫 메시지', '첫 답', '둘째 메시지', '둘째 답']);
    expect(harness.warnings).toContain('conversation summary failed; older turns kept');
  });
});
