import type {
  CalendarEvent,
  CalendarReader,
  GeoPoint,
  MailReader,
  MailSummary,
  TodoItem,
  TodoReader,
  WeatherReport,
  WeatherSource,
} from '../../core/contracts/index.js';
import type { Logger } from '../../core/log/types.js';
import { startOfLocalDay, wallClock } from '../../core/scheduler/next-run.js';
import type { Weekday } from '../../core/time/date-spec.js';

/** One source's share of the briefing. A missing connector and a broken call look different to the owner. */
export type Section<T> = { state: 'ok'; items: readonly T[] } | { state: 'not_connected' } | { state: 'failed' };

export interface BriefingTodo extends TodoItem {
  /** True when the due day is before today in the owner's zone. */
  overdue: boolean;
}

export type WeatherSection =
  | { state: 'ok'; report: WeatherReport }
  | { state: 'not_connected' | 'no_location' | 'failed' };

export interface BriefingData {
  date: { ymd: string; month: number; day: number; weekday: Weekday };
  calendar: Section<CalendarEvent>;
  mail: Section<MailSummary>;
  todo: Section<BriefingTodo>;
  /** Optional so callers that build data by hand (tests) need not guess the weather. */
  weather?: WeatherSection;
}

export interface BriefingSources {
  calendar?: CalendarReader;
  mail?: MailReader;
  todo?: TodoReader;
}

export interface BriefingWeather {
  source: WeatherSource;
  point?: GeoPoint;
}

export interface GatherOptions {
  sources: BriefingSources;
  timeZone: string;
  mailLimit: number;
  weather?: BriefingWeather;
  log: Logger;
}

const WEEKDAY_BY_INDEX: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const UNDATED_LIMIT = 3;
const HOURS_LOOKBACK = 24;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function ymdOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

export interface LocalDay {
  ymd: string;
  month: number;
  day: number;
  weekday: Weekday;
  from: Date;
  to: Date;
}

/** The owner's calendar day around `now`, as a half-open range [start of day, start of next day). */
export function localDayOf(now: Date, timeZone: string): LocalDay {
  const wall = wallClock(now, timeZone);
  const next = new Date(Date.UTC(wall.y, wall.m - 1, wall.d + 1));
  const weekday = WEEKDAY_BY_INDEX[new Date(Date.UTC(wall.y, wall.m - 1, wall.d)).getUTCDay()] ?? 'sun';
  return {
    ymd: ymdOf(wall.y, wall.m, wall.d),
    month: wall.m,
    day: wall.d,
    weekday,
    from: startOfLocalDay(wall.y, wall.m, wall.d, timeZone),
    to: startOfLocalDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
  };
}

function dueDay(due: string, timeZone: string): string | undefined {
  if (YMD.test(due)) return due;
  const instant = new Date(due);
  if (Number.isNaN(instant.getTime())) return undefined;
  const wall = wallClock(instant, timeZone);
  return ymdOf(wall.y, wall.m, wall.d);
}

/** Overdue and due-today first, then at most three undated items; later due days wait for their day. */
function selectTodos(items: readonly TodoItem[], today: string, timeZone: string): BriefingTodo[] {
  const overdue: BriefingTodo[] = [];
  const dueToday: BriefingTodo[] = [];
  const undated: BriefingTodo[] = [];
  for (const item of items) {
    if (item.done) continue;
    const day = item.due === undefined ? undefined : dueDay(item.due, timeZone);
    if (day === undefined) undated.push({ ...item, overdue: false });
    else if (day < today) overdue.push({ ...item, overdue: true });
    else if (day === today) dueToday.push({ ...item, overdue: false });
  }
  return [...overdue, ...dueToday, ...undated.slice(0, UNDATED_LIMIT)];
}

/** A source that is missing or broken leaves its section in a state, never the whole briefing. */
async function loadSection<S, T>(
  source: S | undefined,
  log: Logger,
  failure: string,
  load: (source: S) => Promise<readonly T[]>,
): Promise<Section<T>> {
  if (source === undefined) return { state: 'not_connected' };
  try {
    return { state: 'ok', items: await load(source) };
  } catch (error) {
    log.warn(failure, { error: error instanceof Error ? error.message : String(error) });
    return { state: 'failed' };
  }
}

/** Weather never fails the briefing: a missing location, key or service only drops the line. */
async function loadWeather(
  weather: BriefingWeather | undefined,
  log: Logger,
): Promise<WeatherSection> {
  if (weather === undefined) return { state: 'not_connected' };
  if (weather.point === undefined) return { state: 'no_location' };
  try {
    return { state: 'ok', report: await weather.source.today(weather.point) };
  } catch (error) {
    log.warn('briefing: weather could not be loaded', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { state: 'failed' };
  }
}

export async function gatherBriefing(now: Date, opts: GatherOptions): Promise<BriefingData> {
  const day = localDayOf(now, opts.timeZone);
  const [calendar, mail, todo, weather] = await Promise.all([
    loadSection(opts.sources.calendar, opts.log, 'briefing: calendar events could not be loaded', (reader) =>
      reader
        .listEvents({ from: day.from, to: day.to })
        .then((events) => [...events].sort((a, b) => a.start.localeCompare(b.start))),
    ),
    loadSection(opts.sources.mail, opts.log, 'briefing: mail could not be loaded', (reader) =>
      reader
        .search({ unreadOnly: true, importantOnly: true, sinceHours: HOURS_LOOKBACK, limit: opts.mailLimit })
        .then((found) => found.slice(0, opts.mailLimit)),
    ),
    loadSection(opts.sources.todo, opts.log, 'briefing: to-dos could not be loaded', async (reader) =>
      selectTodos(await reader.open(), day.ymd, opts.timeZone),
    ),
    loadWeather(opts.weather, opts.log),
  ]);

  return {
    date: { ymd: day.ymd, month: day.month, day: day.day, weekday: day.weekday },
    calendar,
    mail,
    todo,
    weather,
  };
}
