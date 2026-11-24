import { describe, expect, it } from 'vitest';
import type {
  CalendarEvent,
  CalendarReader,
  CalendarWriter,
  EventDraft,
  TimeRange,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { calendarSkill } from '../../../src/skills/calendar/plugin.js';
import type { AddEventOutput } from '../../../src/skills/calendar/tools-add.js';
import type { ListedEvent } from '../../../src/skills/calendar/tools-list.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

class FakeCalendar implements CalendarReader, CalendarWriter {
  readonly events: CalendarEvent[] = [];
  readonly ranges: TimeRange[] = [];
  readonly drafts: EventDraft[] = [];

  async listEvents(range: TimeRange): Promise<CalendarEvent[]> {
    this.ranges.push(range);
    const from = range.from.getTime();
    const to = range.to.getTime();
    return this.events.filter((event) => {
      const start = Date.parse(event.start);
      return Number.isFinite(start) && start >= from && start < to;
    });
  }

  async createEvent(draft: EventDraft): Promise<CalendarEvent> {
    this.drafts.push(draft);
    const event: CalendarEvent = {
      id: `evt-${String(this.events.length + 1)}`,
      title: draft.title,
      start: draft.start,
      end: draft.end,
      allDay: draft.allDay,
      ...(draft.location !== undefined ? { location: draft.location } : {}),
      ...(draft.attendees !== undefined ? { attendees: draft.attendees } : {}),
    };
    this.events.push(event);
    return event;
  }
}

async function setup(opts: { confirmer?: FakeConfirmer; now?: Date } = {}) {
  const calendar = new FakeCalendar();
  const context = createTestContext({
    now: opts.now ?? NOW,
    ...(opts.confirmer !== undefined ? { confirmer: opts.confirmer } : {}),
    capabilities: {
      [Contracts.calendarRead.id]: calendar,
      [Contracts.calendarWrite.id]: calendar,
    },
  });
  await calendarSkill().setup(context.ctx);
  return { calendar, ...context };
}

async function execute(
  context: Awaited<ReturnType<typeof setup>>,
  name: string,
  input: unknown,
  grounding: string[] = [],
) {
  return context.ctx.tools.execute(name, input, { grounding });
}

function doneOutput<T>(outcome: Awaited<ReturnType<typeof execute>>): T {
  if (outcome.status !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
  return outcome.output as T;
}

describe('calendar.list_events', () => {
  it('lists the resolved local day and adds a readable local range', async () => {
    const context = await setup();
    context.calendar.events.push({
      id: 'e1',
      title: '회의',
      start: '2026-11-20T15:00:00+09:00',
      end: '2026-11-20T16:00:00+09:00',
      allDay: false,
      location: '3층 회의실',
    });

    const events = doneOutput<ListedEvent[]>(
      await execute(context, 'calendar.list_events', { date: { kind: 'date', date: '2026-11-20' } }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'e1',
      title: '회의',
      allDay: false,
      location: '3층 회의실',
      local: '11월 20일 (금) 15:00–16:00',
    });
    expect(context.calendar.ranges[0]?.from.toISOString()).toBe('2026-11-19T15:00:00.000Z');
    expect(context.calendar.ranges[0]?.to.toISOString()).toBe('2026-11-20T15:00:00.000Z');
  });

  it('extends the range by the requested number of days', async () => {
    const context = await setup();

    await execute(context, 'calendar.list_events', { date: { kind: 'offset', days: 0 }, days: 2 });

    expect(context.calendar.ranges[0]?.from.toISOString()).toBe('2026-11-16T15:00:00.000Z');
    expect(context.calendar.ranges[0]?.to.toISOString()).toBe('2026-11-18T15:00:00.000Z');
  });

  it('labels all-day events', async () => {
    const context = await setup();
    context.calendar.events.push({
      id: 'e1',
      title: '휴가',
      start: '2026-11-20',
      end: '2026-11-21',
      allDay: true,
    });

    const events = doneOutput<ListedEvent[]>(
      await execute(context, 'calendar.list_events', { date: { kind: 'date', date: '2026-11-20' } }),
    );

    expect(events[0]?.local).toBe('11월 20일 (금) 종일');
  });
});

describe('calendar.add_event', () => {
  const GROUNDING = ['내일 오후 3시에 회의가 있어요'];

  it('creates a timed event in the owner zone', async () => {
    const context = await setup();

    const result = doneOutput<AddEventOutput>(
      await execute(
        context,
        'calendar.add_event',
        {
          title: '회의',
          date: { kind: 'offset', days: 1 },
          time: { hour: 3, minute: 0, meridiem: 'pm' },
          evidence: '내일 오후 3시에 회의가 있어요',
        },
        GROUNDING,
      ),
    );

    expect(result.status).toBe('created');
    expect(context.calendar.drafts[0]).toMatchObject({
      title: '회의',
      start: '2026-11-18T15:00:00+09:00',
      end: '2026-11-18T16:00:00+09:00',
      allDay: false,
    });
  });

  it('creates an all-day event ending the next day', async () => {
    const context = await setup();

    const result = doneOutput<AddEventOutput>(
      await execute(
        context,
        'calendar.add_event',
        {
          title: '행사',
          date: { kind: 'date', date: '2026-11-20' },
          evidence: '11월 20일에 행사가 있어요',
        },
        ['11월 20일에 행사가 있어요'],
      ),
    );

    expect(result.status).toBe('created');
    expect(context.calendar.drafts[0]).toMatchObject({ start: '2026-11-20', end: '2026-11-21', allDay: true });
  });

  it('adds the send effect and shows invitees on the approval card', async () => {
    const confirmer = new FakeConfirmer('approved');
    const context = await setup({ confirmer });

    const result = doneOutput<AddEventOutput>(
      await execute(
        context,
        'calendar.add_event',
        {
          title: '회의',
          date: { kind: 'offset', days: 1 },
          time: { hour: 3, minute: 0, meridiem: 'pm' },
          location: '3층 회의실',
          attendees: ['alex@example.com', 'mina@example.com'],
          evidence: '내일 오후 3시에 회의가 있어요',
        },
        GROUNDING,
      ),
    );

    expect(result.status).toBe('created');
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.effects).toEqual(['write', 'send']);
    expect(confirmer.requests[0]?.summary).toContain('alex@example.com, mina@example.com');
    expect(confirmer.requests[0]?.summary).toContain('초대 메일이 가요');
    expect(confirmer.requests[0]?.summary).toContain('근거: "내일 오후 3시에 회의가 있어요"');
  });

  it('rejects evidence that is not in the turn', async () => {
    const context = await setup();

    const outcome = await execute(
      context,
      'calendar.add_event',
      {
        title: '회의',
        date: { kind: 'offset', days: 1 },
        time: { hour: 3, minute: 0, meridiem: 'pm' },
        evidence: '내일 오후 3시에 회의가 있어요',
      },
      ['다른 이야기만 했어요'],
    );

    expect(outcome.status).toBe('rejected');
    expect(context.calendar.drafts).toHaveLength(0);
  });

  it('rejects when the date is not mentioned in the evidence', async () => {
    const context = await setup();

    const outcome = await execute(
      context,
      'calendar.add_event',
      {
        title: '회의',
        date: { kind: 'month_day', month: 12, day: 25 },
        evidence: '내일 오후 3시에 회의가 있어요',
      },
      GROUNDING,
    );

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'the date is not mentioned in the evidence' });
  });

  it('rejects when the time is not mentioned in the evidence', async () => {
    const context = await setup();

    const outcome = await execute(
      context,
      'calendar.add_event',
      {
        title: '회의',
        date: { kind: 'offset', days: 1 },
        time: { hour: 3, minute: 0, meridiem: 'pm' },
        evidence: '내일 회의가 있어요',
      },
      ['내일 회의가 있어요'],
    );

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'the time is not mentioned in the evidence' });
  });

  it('asks with a localized reason when AM/PM was not stated', async () => {
    const confirmer = new FakeConfirmer('approved');
    const context = await setup({ confirmer });

    const result = doneOutput<AddEventOutput>(
      await execute(
        context,
        'calendar.add_event',
        {
          title: '회의',
          date: { kind: 'offset', days: 1 },
          time: { hour: 3, minute: 0, meridiem: 'unspecified' },
          evidence: '내일 3시에 회의가 있어요',
        },
        ['내일 3시에 회의가 있어요'],
      ),
    );

    expect(result.status).toBe('created');
    expect(confirmer.requests[0]?.note).toContain('오전/오후를 말하지 않아서 추측했어요');
  });

  it('returns the existing event instead of creating a near duplicate', async () => {
    const context = await setup();
    context.calendar.events.push({
      id: 'e1',
      title: '팀 회의',
      start: '2026-11-18T15:00:00+09:00',
      end: '2026-11-18T16:00:00+09:00',
      allDay: false,
    });

    const result = doneOutput<AddEventOutput>(
      await execute(
        context,
        'calendar.add_event',
        {
          title: '팀 회의 준비',
          date: { kind: 'offset', days: 1 },
          time: { hour: 3, minute: 30, meridiem: 'pm' },
          evidence: '내일 오후 3시 30분에 팀 회의 준비가 있어요',
        },
        ['내일 오후 3시 30분에 팀 회의 준비가 있어요'],
      ),
    );

    expect(result).toMatchObject({ status: 'duplicate', existing: { id: 'e1' } });
    expect(context.calendar.drafts).toHaveLength(0);
  });

  it('creates a matching-title event outside the two-hour window', async () => {
    const context = await setup();
    context.calendar.events.push({
      id: 'e1',
      title: '팀 회의',
      start: '2026-11-18T15:00:00+09:00',
      end: '2026-11-18T16:00:00+09:00',
      allDay: false,
    });

    const result = doneOutput<AddEventOutput>(
      await execute(
        context,
        'calendar.add_event',
        {
          title: '팀 회의',
          date: { kind: 'offset', days: 1 },
          time: { hour: 5, minute: 0, meridiem: 'pm' },
          evidence: '내일 오후 5시에 팀 회의가 있어요',
        },
        ['내일 오후 5시에 팀 회의가 있어요'],
      ),
    );

    expect(result.status).toBe('created');
    expect(context.calendar.drafts).toHaveLength(1);
  });
});
