import { describe, expect, it } from 'vitest';
import type { CalendarEvent, SpendEntry, SpendReader } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { dayTexts } from '../../../src/skills/day/locale.js';
import { daySkill } from '../../../src/skills/day/plugin.js';
import { isUnusualSpend, NUDGES_JOB } from '../../../src/skills/day/nudges.js';
import { checkSituation } from '../../../src/skills/day/situational.js';
import { createTestContext, ScriptedLlm } from '../../support/context.js';
import { FakeCalendarReader, FakeNotifier, FakeTodoReader, todo } from './helpers.js';

const ko = dayTexts('ko');

describe('checkSituation', () => {
  it('keeps a fitted line and drops filler', () => {
    expect(checkSituation('{"send":true,"category":"meeting","text":"회의록 정리해 둘까요?"}', 'event.before', ko)).toEqual({
      send: true,
      text: '회의록 정리해 둘까요?',
    });
    expect(checkSituation('{"send":true,"category":"personal","text":"끝나셨죠? 수고하셨어요!"}', 'event.before', ko)).toEqual({
      send: false,
      text: null,
    });
  });

  it('lets a card kind go out with the card alone', () => {
    expect(checkSituation('{"send":true,"category":"other","text":null}', 'day.close', ko)).toEqual({ send: true, text: null });
  });

  it('treats broken answers as failure', () => {
    expect(checkSituation('not json', 'day.close', ko)).toBeUndefined();
    expect(checkSituation('{"text":"hi"}', 'day.close', ko)).toBeUndefined();
  });
});

const CLOSE_AT = new Date('2026-11-17T21:30:00+09:00');

async function closeSetup(llm: ScriptedLlm, situational: boolean) {
  const notifier = new FakeNotifier();
  const context = createTestContext({
    now: CLOSE_AT,
    llm,
    config: { situational },
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.todoRead.id]: new FakeTodoReader([todo({ text: '보고서', due: '2026-11-17' })], []),
    },
  });
  await daySkill().setup(context.ctx);
  return { notifier, ...context };
}

describe('day.close with situational judgment', () => {
  it('is off by default: the fixed card goes out without a model call', async () => {
    const llm = new ScriptedLlm();
    const { notifier, scheduler } = await closeSetup(llm, false);
    await scheduler.run('day.close', CLOSE_AT);
    expect(llm.requests).toHaveLength(0);
    expect(notifier.notices[0]?.text).toContain('오늘 마감');
  });

  it('puts the judged line above the card', async () => {
    const llm = new ScriptedLlm(['{"send":true,"category":"work","text":"보고서 마감이 오늘이에요."}']);
    const { notifier, scheduler } = await closeSetup(llm, true);
    await scheduler.run('day.close', CLOSE_AT);
    expect(llm.requests[0]?.tier).toBe('fast');
    expect(llm.requests[0]?.jsonSchema).toBeDefined();
    expect(notifier.notices[0]?.text.startsWith('보고서 마감이 오늘이에요.\n\n오늘 마감')).toBe(true);
  });

  it('stays silent when the model says there is nothing', async () => {
    const llm = new ScriptedLlm(['{"send":false,"category":"other","text":null}']);
    const { notifier, scheduler } = await closeSetup(llm, true);
    await scheduler.run('day.close', CLOSE_AT);
    expect(notifier.notices).toHaveLength(0);
  });

  it('keeps the fixed card when the judgment fails', async () => {
    const llm = new ScriptedLlm(['garbage']);
    const { notifier, scheduler } = await closeSetup(llm, true);
    await scheduler.run('day.close', CLOSE_AT);
    expect(notifier.notices[0]?.text.startsWith('오늘 마감')).toBe(true);
  });
});

const NOW = new Date('2026-11-17T14:00:00+09:00');
const meeting: CalendarEvent = {
  id: 'e1',
  title: '디자인 리뷰',
  start: '2026-11-17T14:40:00+09:00',
  end: '2026-11-17T15:30:00+09:00',
  allDay: false,
  location: '3층 회의실',
};
const bare: CalendarEvent = {
  id: 'e2',
  title: '집중 시간',
  start: meeting.start,
  end: meeting.end,
  allDay: false,
};

async function nudgeSetup(llm: ScriptedLlm, nudges: Record<string, unknown>, events: CalendarEvent[]) {
  const notifier = new FakeNotifier();
  const context = createTestContext({
    now: NOW,
    llm,
    config: { prep: false, travel: false, close: false, replies: false, voice: false, health: false, nudges },
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.calendarRead.id]: new FakeCalendarReader(() => events),
    },
  });
  await daySkill().setup(context.ctx);
  return { notifier, ...context };
}

describe('day nudges', () => {
  it('registers no job while every trigger is off', async () => {
    const { scheduler } = await nudgeSetup(new ScriptedLlm(), { beforeEvent: false, midday: false }, []);
    expect(scheduler.jobs.has(NUDGES_JOB)).toBe(false);
  });

  it('judges an event with something to prepare once, and skips a bare one without a model call', async () => {
    const llm = new ScriptedLlm(['{"send":true,"category":"meeting","text":"3층 회의실이에요. 시안 파일 챙기세요."}']);
    const { notifier, scheduler } = await nudgeSetup(llm, { beforeEvent: true }, [meeting, bare]);
    await scheduler.run(NUDGES_JOB, NOW);
    await scheduler.run(NUDGES_JOB, NOW);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.messages[1]?.content).toContain('<data kind="facts">');
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.kind).toBe('day.nudge.event.before');
  });

  it('sends nothing when the model chooses silence', async () => {
    const llm = new ScriptedLlm(['{"send":false,"category":"personal","text":null}']);
    const { notifier, scheduler } = await nudgeSetup(llm, { beforeEvent: true }, [meeting]);
    await scheduler.run(NUDGES_JOB, NOW);
    expect(notifier.notices).toHaveLength(0);
  });

  it('stops at the hourly cap, which survives in the store', async () => {
    const second = { ...meeting, id: 'e3', start: '2026-11-17T14:50:00+09:00' };
    const llm = new ScriptedLlm([
      '{"send":true,"category":"meeting","text":"하나"}',
      '{"send":true,"category":"meeting","text":"둘"}',
    ]);
    const { notifier, scheduler, kv } = await nudgeSetup(llm, { beforeEvent: true, perHour: 1 }, [meeting, second]);
    await scheduler.run(NUDGES_JOB, NOW);
    expect(notifier.notices).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
    expect(await kv.get<number[]>('nudges.sent')).toHaveLength(1);
  });

  it('flags only payments far above the category median', () => {
    const base = (id: string, amount: number, day: number): SpendEntry => ({
      id,
      at: new Date(Date.UTC(2026, 10, day, 3)).toISOString(),
      merchant: 'shop',
      merchantKey: 'shop',
      amount,
      currency: 'KRW',
      originalAmount: amount,
      source: 'sms',
      category: 'food',
      categorySource: 'rule',
    });
    const history = [1, 2, 3, 4, 5].map((day) => base(`h${day}`, 10_000, day));
    expect(isUnusualSpend(base('big', 40_000, 10), history, 3)).toBe(true);
    expect(isUnusualSpend(base('ok', 20_000, 10), history, 3)).toBe(false);
    expect(isUnusualSpend(base('few', 90_000, 10), history.slice(0, 3), 3)).toBe(false);
  });

  it('starts the spend cursor at the first run instead of replaying old payments', async () => {
    const reader: SpendReader = { entries: async () => [], homeCurrency: () => 'KRW' };
    const llm = new ScriptedLlm();
    const notifier = new FakeNotifier();
    const context = createTestContext({
      now: NOW,
      llm,
      config: { nudges: { spend: true } },
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.spendRead.id]: reader },
    });
    await daySkill().setup(context.ctx);
    await context.scheduler.run(NUDGES_JOB, NOW);
    expect(await context.kv.get('nudges.spendCursor')).toBe(NOW.toISOString());
    expect(llm.requests).toHaveLength(0);
  });
});
