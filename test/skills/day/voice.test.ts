import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { PhoneVoiceMemo } from '../../../src/core/contracts/index.js';
import { Caps } from '../../../src/core/plugin/types.js';
import { dateSpecSchema, timeSpecSchema } from '../../../src/core/time/date-spec.js';
import { dayTexts } from '../../../src/skills/day/locale.js';
import { processVoiceMemo } from '../../../src/skills/day/voice.js';
import { daySkill } from '../../../src/skills/day/plugin.js';
import { flush } from '../../core/helpers.js';
import { createTestContext, FakeConfirmer, ScriptedLlm } from '../../support/context.js';
import { FakeMemoryWriter, FakeNotifier, FakeTodoWriter } from './helpers.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const MEMO_TEXT = '내일 9시 팀 회의가 있어. 우유 사야 해. 새 프로젝트 아이디어도 적어 둬.';

const memo: PhoneVoiceMemo = {
  deviceId: 'phone-1',
  text: MEMO_TEXT,
  at: NOW,
};

class CalendarToolRecorder {
  readonly calls: Record<string, unknown>[] = [];
  fail = false;
}

function setup(options: { llm?: ScriptedLlm; withCalendar?: boolean; answer?: 'approved' | 'denied' } = {}) {
  const notifier = new FakeNotifier();
  const todoWriter = new FakeTodoWriter();
  const memory = new FakeMemoryWriter();
  const confirmer = new FakeConfirmer(options.answer ?? 'approved');
  const llm = options.llm ?? new ScriptedLlm();
  const context = createTestContext({
    now: NOW,
    llm,
    confirmer,
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.todoWrite.id]: todoWriter,
      [Contracts.memoryWrite.id]: memory,
      [Caps.confirmer.id]: confirmer,
    },
  });
  const calendar = new CalendarToolRecorder();
  if (options.withCalendar ?? true) {
    context.ctx.registerTool({
      name: 'calendar.add_event',
      description: 'fake calendar',
      input: z.object({
        title: z.string(),
        date: dateSpecSchema,
        time: timeSpecSchema.optional(),
        durationMinutes: z.number().optional(),
        location: z.string().optional(),
        evidence: z.string(),
      }),
      effects: ['write'],
      async run(input) {
        calendar.calls.push(input);
        return { status: 'created', event: { id: 'e1' } };
      },
    });
  }
  return { notifier, todoWriter, memory, confirmer, calendar, llm, context };
}

function memoJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    todos: [{ text: '우유 사기', due: { kind: 'offset', days: 1 } }],
    events: [
      {
        title: '팀 회의',
        date: { kind: 'offset', days: 1 },
        time: { hour: 9, minute: 0, meridiem: 'am' },
        location: '본관',
        evidence: '내일 9시 팀 회의',
      },
    ],
    notes: ['새 프로젝트 아이디어'],
    ...overrides,
  });
}

describe('processVoiceMemo', () => {
  it('adds to-dos, asks about events with evidence, remembers notes and summarizes', async () => {
    const { notifier, todoWriter, memory, confirmer, calendar, llm, context } = setup({
      llm: new ScriptedLlm([memoJson()]),
    });

    await processVoiceMemo(context.ctx, memo, dayTexts('ko'));

    expect(todoWriter.drafts).toEqual([{ text: '우유 사기', due: '2026-11-18' }]);
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]).toMatchObject({
      summary: '팀 회의 (2026-11-18 09:00)',
      effects: ['write'],
      toolName: 'calendar.add_event',
      note: '음성 메모에서 찾은 일정이에요',
    });
    expect(calendar.calls).toHaveLength(1);
    expect(calendar.calls[0]).toMatchObject({
      title: '팀 회의',
      location: '본관',
      evidence: '내일 9시 팀 회의',
    });
    expect(memory.remembered).toHaveLength(1);
    expect(memory.remembered[0]).toMatchObject({ subject: 'owner', text: '새 프로젝트 아이디어', source: { kind: 'phone' } });
    expect(notifier.notices[0]).toMatchObject({ kind: 'day.voice', text: '할 일 1개 추가, 일정 1개 확인 요청' });

    const request = llm.requests[0];
    expect(request).toMatchObject({ purpose: 'day.voice_memo', tier: 'fast', sensitivity: 'sensitive' });
    expect(request?.jsonSchema).toBeDefined();
    expect(request?.messages.at(-1)?.content).toContain('<data kind="voice_memo">');
    expect(request?.messages.at(-1)?.content).toContain('우유 사야 해');
  });

  it('does not ask about an event whose evidence is not in the memo', async () => {
    const split = memoJson({
      events: [
        { title: '팀 회의', date: { kind: 'offset', days: 1 }, evidence: '다음 주 화요일 회의' },
      ],
    });
    const { notifier, confirmer, calendar, context } = setup({ llm: new ScriptedLlm([split]) });

    await processVoiceMemo(context.ctx, memo, dayTexts('ko'));

    expect(confirmer.requests).toHaveLength(0);
    expect(calendar.calls).toHaveLength(0);
    expect(notifier.notices[0]?.text).toBe('할 일 1개 추가, 일정 0개 확인 요청');
  });

  it('adds the event as a to-do when the calendar tool is not available', async () => {
    const { todoWriter, confirmer, notifier, context } = setup({
      llm: new ScriptedLlm([memoJson()]),
      withCalendar: false,
    });

    await processVoiceMemo(context.ctx, memo, dayTexts('ko'));

    expect(confirmer.requests).toHaveLength(0);
    expect(todoWriter.drafts).toHaveLength(2);
    expect(todoWriter.drafts[1]).toEqual({ text: '팀 회의', due: '2026-11-18T09:00:00+09:00' });
    expect(notifier.notices[0]?.text).toBe('할 일 2개 추가, 일정 0개 확인 요청');
  });

  it('does not add the event when the owner declines', async () => {
    const { calendar, notifier, context } = setup({
      llm: new ScriptedLlm([memoJson()]),
      answer: 'denied',
    });

    await processVoiceMemo(context.ctx, memo, dayTexts('ko'));

    expect(calendar.calls).toHaveLength(0);
    expect(notifier.notices[0]?.text).toBe('할 일 1개 추가, 일정 1개 확인 요청');
  });

  it('degrades quietly when the model fails or answers with junk', async () => {
    const failing = setup({ llm: new ScriptedLlm([]) });
    await expect(processVoiceMemo(failing.context.ctx, memo, dayTexts('ko'))).resolves.toBeUndefined();
    expect(failing.notifier.notices).toHaveLength(0);

    const junk = setup({ llm: new ScriptedLlm(['not json']) });
    await expect(processVoiceMemo(junk.context.ctx, memo, dayTexts('ko'))).resolves.toBeUndefined();
    expect(junk.notifier.notices).toHaveLength(0);
  });

  it('drops invalid to-do and event entries but keeps the rest', async () => {
    const split = JSON.stringify({
      todos: [{ text: '좋은 일' }, { text: '' }],
      events: [{ title: '회의', date: { kind: 'nope' }, evidence: '내일 9시 팀 회의' }],
      notes: ['기억할 것'],
    });
    const { todoWriter, confirmer, context } = setup({ llm: new ScriptedLlm([split]) });

    await processVoiceMemo(context.ctx, memo, dayTexts('ko'));

    expect(todoWriter.drafts).toEqual([{ text: '좋은 일' }]);
    expect(confirmer.requests).toHaveLength(0);
  });
});

describe('voice memo bus wiring', () => {
  it('processes a memo without blocking the bus handler', async () => {
    const { notifier, context } = setup({ llm: new ScriptedLlm([memoJson()]) });
    await daySkill().setup(context.ctx);

    await context.bus.emit('phone.voice_memo', memo);
    for (let index = 0; index < 5; index += 1) await flush();

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.kind).toBe('day.voice');
  });
});
