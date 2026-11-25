import { describe, expect, it } from 'vitest';
import type { CalendarEvent, PersonSummary } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { daySkill } from '../../../src/skills/day/plugin.js';
import { createTestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { FakeCalendarReader, FakeMailReader, FakeNotifier, FakePeople, summary } from './helpers.js';

const NOW = new Date('2026-11-17T20:00:00+09:00');
const TOMORROW_START = new Date('2026-11-18T00:00:00+09:00').getTime();

const meeting: CalendarEvent = {
  id: 'e1',
  title: '팀 회의',
  start: '2026-11-18T09:00:00+09:00',
  end: '2026-11-18T10:00:00+09:00',
  allDay: false,
  location: '본관 3층',
  attendees: ['민수'],
};

const lunch: CalendarEvent = {
  id: 'e2',
  title: '점심 약속',
  start: '2026-11-18T12:00:00+09:00',
  end: '2026-11-18T13:00:00+09:00',
  allDay: false,
};

const allDay: CalendarEvent = {
  id: 'e3',
  title: '창립 기념일',
  start: '2026-11-18',
  end: '2026-11-19',
  allDay: true,
};

const person: PersonSummary = {
  key: 'minsu',
  names: ['민수'],
  emails: ['minsu@example.com'],
  interactions: [],
  commitments: [
    {
      id: 'c1',
      direction: 'mine',
      kind: 'promise',
      text: '견적서 보내기',
      at: '2026-11-16T09:00:00+09:00',
      done: false,
    },
    {
      id: 'c2',
      direction: 'mine',
      kind: 'promise',
      text: '끝난 약속',
      at: '2026-11-15T09:00:00+09:00',
      done: true,
    },
  ],
};

async function setup(options: TestContextOptions = {}) {
  const notifier = new FakeNotifier();
  const calendar = new FakeCalendarReader(() => [meeting, lunch, allDay]);
  const mail = new FakeMailReader([summary({ subject: '견적서 회신' })]);
  const people = new FakePeople({ 민수: person });
  const context = createTestContext({
    now: NOW,
    ...options,
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.calendarRead.id]: calendar,
      [Contracts.mailRead.id]: mail,
      [Contracts.peopleRead.id]: people,
      ...(options.capabilities ?? {}),
    },
  });
  await daySkill().setup(context.ctx);
  return { notifier, calendar, mail, people, ...context };
}

describe('day.prep', () => {
  it('lists tomorrow, confirms locations, commitments and related mail', async () => {
    const { notifier, calendar, mail, scheduler } = await setup();

    await scheduler.run('day.prep', NOW);

    expect(calendar.ranges[0]?.from.getTime()).toBe(TOMORROW_START);
    expect(calendar.ranges[0]?.to.getTime()).toBe(new Date('2026-11-19T00:00:00+09:00').getTime());
    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice?.kind).toBe('day.prep');
    expect(notice?.dedupeKey).toBe('2026-11-18');

    const text = notice?.text ?? '';
    expect(text).toContain('내일 일정을 미리 봤어요');
    expect(text).toContain('09:00 팀 회의 @본관 3층');
    expect(text).toContain('장소 확인');
    expect(text).toContain('12:00 점심 약속');
    expect(text).toContain('장소가 안 적혀 있어요');
    expect(text).toContain('종일 창립 기념일');
    expect(text).toContain('민수님께 약속: 견적서 보내기');
    expect(text).not.toContain('끝난 약속');
    expect(text).toContain('관련 메일: 견적서 회신');

    expect(mail.queries.some((query) => query.text === '팀 회의')).toBe(true);
    expect(mail.queries[0]).toMatchObject({ sinceHours: 336, limit: 2 });
  });

  it('stays quiet when tomorrow is empty', async () => {
    const { notifier, scheduler } = await setup({
      capabilities: { [Contracts.calendarRead.id]: new FakeCalendarReader(() => []) },
    });

    await scheduler.run('day.prep', NOW);
    expect(notifier.notices).toHaveLength(0);
  });

  it('does nothing without a calendar capability', async () => {
    const notifier = new FakeNotifier();
    const context = createTestContext({ now: NOW, capabilities: { [Contracts.notifier.id]: notifier } });
    await daySkill().setup(context.ctx);

    await expect(context.scheduler.run('day.prep', NOW)).resolves.toBeUndefined();
    expect(notifier.notices).toHaveLength(0);
  });

  it('still sends the notice when mail and people are not connected', async () => {
    const notifier = new FakeNotifier();
    const context = createTestContext({
      now: NOW,
      capabilities: {
        [Contracts.notifier.id]: notifier,
        [Contracts.calendarRead.id]: new FakeCalendarReader(() => [meeting]),
      },
    });
    await daySkill().setup(context.ctx);
    await context.scheduler.run('day.prep', NOW);

    expect(notifier.notices[0]?.text).toContain('장소 확인');
    expect(notifier.notices[0]?.text).not.toContain('관련 메일');
  });
});
