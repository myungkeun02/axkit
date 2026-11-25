import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { daySkill } from '../../../src/skills/day/plugin.js';
import { createTestContext } from '../../support/context.js';
import { FakeCalendarReader, FakeNotifier, FakePhone, FakeTodoReader, todo } from './helpers.js';

const NOW = new Date('2026-11-17T21:30:00+09:00');
const TODAY_START = new Date('2026-11-17T00:00:00+09:00').getTime();
const TOMORROW_START = new Date('2026-11-18T00:00:00+09:00').getTime();

const todayEvent: CalendarEvent = {
  id: 'e1',
  title: '팀 회의',
  start: '2026-11-17T09:00:00+09:00',
  end: '2026-11-17T10:00:00+09:00',
  allDay: false,
};
const todaySecond: CalendarEvent = {
  id: 'e2',
  title: '점심',
  start: '2026-11-17T12:00:00+09:00',
  end: '2026-11-17T13:00:00+09:00',
  allDay: false,
};
const tomorrowFirst: CalendarEvent = {
  id: 'e3',
  title: '아침 회의',
  start: '2026-11-18T08:30:00+09:00',
  end: '2026-11-18T09:00:00+09:00',
  allDay: false,
};
const tomorrowLater: CalendarEvent = {
  id: 'e4',
  title: '저녁 약속',
  start: '2026-11-18T18:00:00+09:00',
  end: '2026-11-18T19:00:00+09:00',
  allDay: false,
};

async function setup(options: { todo?: FakeTodoReader; phone?: FakePhone; withSources?: boolean } = {}) {
  const notifier = new FakeNotifier();
  const calendar = new FakeCalendarReader((range) =>
    range.from.getTime() === TODAY_START ? [todayEvent, todaySecond] : [tomorrowLater, tomorrowFirst],
  );
  const todoReader =
    options.todo ??
    new FakeTodoReader(
      [
        todo({ id: 'a', text: '어제 일', due: '2026-11-16' }),
        todo({ id: 'b', text: '오늘 일', due: '2026-11-17' }),
        todo({ id: 'c', text: '내일 일', due: '2026-11-18' }),
        todo({ id: 'd', text: '모레 일', due: '2026-11-19' }),
        todo({ id: 'e', text: '마감 없음' }),
      ],
      [todo({ id: 'done', text: '끝난 일', done: true, completedAt: '2026-11-17T10:00:00+09:00' })],
    );
  const phone = options.phone ?? new FakePhone(undefined, { steps: 4200 });
  const withSources = options.withSources ?? true;
  const context = createTestContext({
    now: NOW,
    capabilities: {
      [Contracts.notifier.id]: notifier,
      ...(withSources
        ? {
            [Contracts.calendarRead.id]: calendar,
            [Contracts.todoRead.id]: todoReader,
            [Contracts.phoneSignals.id]: phone,
          }
        : {}),
    },
  });
  await daySkill().setup(context.ctx);
  return { notifier, calendar, todoReader, phone, ...context };
}

describe('day.close', () => {
  it('summarizes the day deterministically', async () => {
    const { notifier, calendar, scheduler } = await setup();

    await scheduler.run('day.close', NOW);

    expect(calendar.ranges.map((range) => range.from.getTime())).toEqual([TODAY_START, TOMORROW_START]);
    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice?.kind).toBe('day.close');
    expect(notice?.dedupeKey).toBe('2026-11-17');

    const text = notice?.text ?? '';
    expect(text).toContain('오늘 하루 정리해 봤어요.');
    expect(text).toContain('일정 2개');
    expect(text).toContain('할 일 1개 완료');
    expect(text).toContain('남은 할 일');
    expect(text).toContain('어제 일 (지남)');
    expect(text).toContain('오늘 일 (오늘)');
    expect(text).toContain('내일 일 (내일)');
    expect(text).not.toContain('모레 일');
    expect(text).not.toContain('마감 없음');
    expect(text).toContain('내일 첫 일정: 08:30 아침 회의');
    expect(text).toContain('오늘 걸음 4,200보');
  });

  it('shows at most five open to-dos', async () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      todo({ id: `t${index}`, text: `일 ${index}`, due: '2026-11-17' }),
    );
    const { notifier, scheduler } = await setup({ todo: new FakeTodoReader(many, []) });

    await scheduler.run('day.close', NOW);
    const lines = (notifier.notices[0]?.text ?? '').split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(5);
  });

  it('says there is nothing left when the list is empty', async () => {
    const { notifier, scheduler } = await setup({ todo: new FakeTodoReader([], []) });
    await scheduler.run('day.close', NOW);
    expect(notifier.notices[0]?.text).toContain('남은 할 일은 없어요.');
  });

  it('sends only what it knows when sources are missing', async () => {
    const { notifier, scheduler } = await setup({ withSources: false });
    await scheduler.run('day.close', NOW);

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.text).toBe('오늘 하루 정리해 봤어요.');
  });

  it('omits the steps line when the phone has no data', async () => {
    const { notifier, scheduler } = await setup({ phone: new FakePhone(undefined, {}) });
    await scheduler.run('day.close', NOW);
    expect(notifier.notices[0]?.text).not.toContain('걸음');
  });
});
