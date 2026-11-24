import { describe, expect, it } from 'vitest';
import type {
  CalendarEvent,
  CalendarReader,
  GeoPoint,
  MailMessage,
  MailQuery,
  MailReader,
  MailSummary,
  TimeRange,
  TodoItem,
  TodoReader,
  WeatherReport,
  WeatherSource,
} from '../../../src/core/contracts/index.js';
import type { Logger } from '../../../src/core/log/types.js';
import { gatherBriefing } from '../../../src/skills/briefing/gather.js';
import type { BriefingSources } from '../../../src/skills/briefing/gather.js';

const TZ = 'Asia/Seoul';

function recorder(warnings: string[]): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warnings.push(msg);
    },
    error: () => {},
    child: () => logger,
  };
  return logger;
}

function options(sources: BriefingSources, mailLimit = 5) {
  return { sources, timeZone: TZ, mailLimit, log: recorder([]) };
}

class FakeCalendar implements CalendarReader {
  readonly ranges: TimeRange[] = [];
  constructor(private readonly events: CalendarEvent[] | Error) {}
  async listEvents(range: TimeRange): Promise<CalendarEvent[]> {
    this.ranges.push(range);
    if (this.events instanceof Error) throw this.events;
    return this.events;
  }
}

class FakeMail implements MailReader {
  readonly queries: MailQuery[] = [];
  constructor(private readonly found: MailSummary[] | Error) {}
  async search(query: MailQuery): Promise<MailSummary[]> {
    this.queries.push(query);
    if (this.found instanceof Error) throw this.found;
    return this.found;
  }
  async read(): Promise<MailMessage> {
    throw new Error('not implemented in the fake');
  }
}

class FakeTodo implements TodoReader {
  constructor(private readonly items: TodoItem[] | Error) {}
  async open(): Promise<TodoItem[]> {
    if (this.items instanceof Error) throw this.items;
    return this.items;
  }
  async doneSince(): Promise<TodoItem[]> {
    return [];
  }
}

class FakeWeather implements WeatherSource {
  readonly points: GeoPoint[] = [];
  constructor(private readonly report: WeatherReport | Error) {}
  async today(point: GeoPoint): Promise<WeatherReport> {
    this.points.push(point);
    if (this.report instanceof Error) throw this.report;
    return this.report;
  }
}

const REPORT: WeatherReport = {
  sky: '맑음',
  tempC: 9,
  minC: 3,
  maxC: 12,
  observedAt: new Date('2026-11-17T08:50:00+09:00'),
};

const POINT: GeoPoint = { lat: 37.5665, lng: 126.978 };

function event(id: string, start: string): CalendarEvent {
  return { id, title: id, start, end: start, allDay: false };
}

function mailSummary(index: number): MailSummary {
  return {
    id: `mail-${index}`,
    threadId: `thread-${index}`,
    from: 'Mina',
    subject: `subject ${index}`,
    snippet: `snippet ${index}`,
    receivedAt: new Date('2026-11-17T07:00:00+09:00'),
    unread: true,
    important: true,
  };
}

function todo(id: string, due?: string, done = false): TodoItem {
  return {
    id,
    text: id,
    done,
    createdAt: '2026-11-01T00:00:00+09:00',
    ...(due !== undefined ? { due } : {}),
  };
}

describe('gatherBriefing', () => {
  it('uses the local day in the owner zone, not the UTC day, late at night', async () => {
    const calendar = new FakeCalendar([event('b', '2026-11-17T15:00:00+09:00'), event('a', '2026-11-17T09:00:00+09:00')]);
    const data = await gatherBriefing(new Date('2026-11-17T23:30:00+09:00'), options({ calendar }));

    expect(data.date).toMatchObject({ ymd: '2026-11-17', month: 11, day: 17, weekday: 'tue' });
    expect(calendar.ranges[0]?.from.toISOString()).toBe('2026-11-16T15:00:00.000Z');
    expect(calendar.ranges[0]?.to.toISOString()).toBe('2026-11-17T15:00:00.000Z');
    if (data.calendar.state !== 'ok') throw new Error('expected ok');
    expect(data.calendar.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('rolls the range to the next day just after local midnight', async () => {
    const calendar = new FakeCalendar([]);
    const data = await gatherBriefing(new Date('2026-11-18T00:30:00+09:00'), options({ calendar }));

    expect(data.date).toMatchObject({ ymd: '2026-11-18', weekday: 'wed' });
    expect(calendar.ranges[0]?.from.toISOString()).toBe('2026-11-17T15:00:00.000Z');
    expect(calendar.ranges[0]?.to.toISOString()).toBe('2026-11-18T15:00:00.000Z');
  });

  it('asks for unread important mail from the last day and caps the result', async () => {
    const found = Array.from({ length: 6 }, (_, index) => mailSummary(index));
    const mail = new FakeMail(found);
    const data = await gatherBriefing(new Date('2026-11-17T09:00:00+09:00'), options({ mail }, 3));

    expect(mail.queries[0]).toEqual({ unreadOnly: true, importantOnly: true, sinceHours: 24, limit: 3 });
    if (data.mail.state !== 'ok') throw new Error('expected ok');
    expect(data.mail.items).toHaveLength(3);
  });

  it('puts overdue and due-today to-dos first, then at most three undated ones', async () => {
    const todoReader = new FakeTodo([
      todo('future', '2026-11-19'),
      todo('u1'),
      todo('overdue', '2026-11-16'),
      todo('today', '2026-11-17T18:00:00+09:00'),
      todo('u2'),
      todo('done', '2026-11-16', true),
      todo('u3'),
      todo('u4'),
    ]);
    const data = await gatherBriefing(new Date('2026-11-17T09:00:00+09:00'), options({ todo: todoReader }));

    if (data.todo.state !== 'ok') throw new Error('expected ok');
    expect(data.todo.items.map((item) => item.id)).toEqual(['overdue', 'today', 'u1', 'u2', 'u3']);
    expect(data.todo.items.map((item) => item.overdue)).toEqual([true, false, false, false, false]);
  });

  it('marks every section not connected when no connector provides it', async () => {
    const warnings: string[] = [];
    const data = await gatherBriefing(new Date('2026-11-17T09:00:00+09:00'), {
      sources: {},
      timeZone: TZ,
      mailLimit: 5,
      log: recorder(warnings),
    });

    expect(data.calendar).toEqual({ state: 'not_connected' });
    expect(data.mail).toEqual({ state: 'not_connected' });
    expect(data.todo).toEqual({ state: 'not_connected' });
    expect(warnings).toEqual([]);
  });

  it('keeps the other sections when one source throws', async () => {
    const warnings: string[] = [];
    const data = await gatherBriefing(new Date('2026-11-17T09:00:00+09:00'), {
      sources: {
        calendar: new FakeCalendar(new Error('quota exceeded')),
        mail: new FakeMail([mailSummary(1)]),
        todo: new FakeTodo([todo('u1')]),
      },
      timeZone: TZ,
      mailLimit: 5,
      log: recorder(warnings),
    });

    expect(data.calendar).toEqual({ state: 'failed' });
    expect(data.mail.state).toBe('ok');
    expect(data.todo.state).toBe('ok');
    expect(warnings).toEqual(['briefing: calendar events could not be loaded']);
  });

  it('includes today\'s weather for the resolved point', async () => {
    const weather = new FakeWeather(REPORT);
    const data = await gatherBriefing(new Date('2026-11-17T09:00:00+09:00'), {
      ...options({}),
      weather: { source: weather, point: POINT },
    });

    expect(weather.points).toEqual([POINT]);
    expect(data.weather).toEqual({ state: 'ok', report: REPORT });
  });

  it('marks weather no_location when no point could be resolved', async () => {
    const weather = new FakeWeather(REPORT);
    const data = await gatherBriefing(new Date('2026-11-17T09:00:00+09:00'), {
      ...options({}),
      weather: { source: weather },
    });

    expect(data.weather).toEqual({ state: 'no_location' });
    expect(weather.points).toEqual([]);
  });

  it('marks weather failed without failing the rest of the briefing', async () => {
    const warnings: string[] = [];
    const data = await gatherBriefing(new Date('2026-11-17T09:00:00+09:00'), {
      sources: { todo: new FakeTodo([todo('u1')]) },
      timeZone: TZ,
      mailLimit: 5,
      weather: { source: new FakeWeather(new Error('no key')), point: POINT },
      log: recorder(warnings),
    });

    expect(data.weather).toEqual({ state: 'failed' });
    expect(data.todo.state).toBe('ok');
    expect(warnings).toEqual(['briefing: weather could not be loaded']);
  });

  it('marks weather not_connected when the connector is absent', async () => {
    const data = await gatherBriefing(new Date('2026-11-17T09:00:00+09:00'), options({}));
    expect(data.weather).toEqual({ state: 'not_connected' });
  });
});
