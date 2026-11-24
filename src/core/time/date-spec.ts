import { z } from 'zod';
import { nextDailyRun, startOfLocalDay, wallClock } from '../scheduler/next-run.js';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type DateSpec =
  | { kind: 'date'; date: string }
  | { kind: 'offset'; days: number }
  | { kind: 'weekday'; weekday: Weekday; week: 'this' | 'next' | 'nearest' }
  | { kind: 'month_day'; month: number; day: number };

export interface TimeSpec {
  hour: number;
  minute: number;
  meridiem: 'am' | 'pm' | 'unspecified';
}

export interface ResolvedDate {
  ymd: string;
  weekday: Weekday;
  /** Why the date is uncertain, in English. Its presence means the owner should confirm. */
  guess?: string;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Sunday first, matching Date.getUTCDay(). */
const WEEKDAY_BY_INDEX: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Monday first: the week rule says Sunday closes the week, not opens it. */
const WEEKDAY_ORDER: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM_UNIT_MS = 60_000;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatYmd(parts: Ymd): string {
  return `${String(parts.y).padStart(4, '0')}-${pad2(parts.m)}-${pad2(parts.d)}`;
}

function parseYmd(value: string): Ymd {
  const match = YMD.exec(value);
  if (match === null) throw new RangeError(`Invalid date "${value}": expected YYYY-MM-DD`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new RangeError(`Invalid date "${value}"`);
  }
  return { y, m, d };
}

function parseHhmm(value: string): { hh: number; mm: number } {
  const match = HHMM.exec(value);
  if (match === null) throw new RangeError(`Invalid time "${value}": expected HH:MM`);
  return { hh: Number(match[1]), mm: Number(match[2]) };
}

function weekdayOf(parts: Ymd): Weekday {
  const index = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
  return WEEKDAY_BY_INDEX[index] ?? 'sun';
}

function addDays(parts: Ymd, days: number): Ymd {
  const shifted = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days));
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

function weekdayIndex(parts: Ymd): number {
  return (new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay() + 6) % 7;
}

function resolved(parts: Ymd, weekday: Weekday, guess: string | undefined): ResolvedDate {
  return { ymd: formatYmd(parts), weekday, ...(guess !== undefined ? { guess } : {}) };
}

function resolveExplicitDate(value: string, today: Ymd): ResolvedDate {
  const target = parseYmd(value);
  const guess = formatYmd(target) < formatYmd(today) ? 'date is in the past' : undefined;
  return resolved(target, weekdayOf(target), guess);
}

function resolveOffset(days: number, today: Ymd): ResolvedDate {
  if (!Number.isInteger(days) || days < -7 || days > 60) {
    throw new RangeError(`Invalid day offset ${days}: expected an integer from -7 to 60`);
  }
  const target = addDays(today, days);
  return resolved(target, weekdayOf(target), undefined);
}

function resolveWeekday(weekday: Weekday, week: 'this' | 'next' | 'nearest', today: Ymd): ResolvedDate {
  const todayIndex = weekdayIndex(today);
  const targetIndex = WEEKDAY_ORDER.indexOf(weekday);
  let diff: number;
  let guess: string | undefined;
  if (week === 'this') {
    diff = targetIndex - todayIndex;
    if (diff < 0) guess = 'already passed this week';
  } else if (week === 'next') {
    diff = targetIndex - todayIndex + 7;
  } else {
    diff = (targetIndex - todayIndex + 7) % 7;
    if (diff === 0) guess = 'today or next week';
  }
  const target = addDays(today, diff);
  return resolved(target, weekday, guess);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function resolveMonthDay(month: number, day: number, today: Ymd): ResolvedDate {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Invalid month ${month}: expected 1-12`);
  }
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(2000, month)) {
    throw new RangeError(`Invalid day ${day} for month ${month}`);
  }
  let year = today.y;
  while (day > daysInMonth(year, month)) year += 1;
  let guess: string | undefined = year === today.y ? undefined : 'year inferred';
  if (month < today.m || (month === today.m && day < today.d)) {
    if (year === today.y) {
      year += 1;
      while (day > daysInMonth(year, month)) year += 1;
    }
    guess = 'year inferred';
  }
  const target: Ymd = { y: year, m: month, d: day };
  return resolved(target, weekdayOf(target), guess);
}

/** Turns a stated date into a concrete calendar day in the owner's time zone. */
export function resolveDate(spec: DateSpec, now: Date, timeZone: string): ResolvedDate {
  const clock = wallClock(now, timeZone);
  const today: Ymd = { y: clock.y, m: clock.m, d: clock.d };
  switch (spec.kind) {
    case 'date':
      return resolveExplicitDate(spec.date, today);
    case 'offset':
      return resolveOffset(spec.days, today);
    case 'weekday':
      return resolveWeekday(spec.weekday, spec.week, today);
    case 'month_day':
      return resolveMonthDay(spec.month, spec.day, today);
  }
}

function guessUnspecified(hour: number): number {
  if (hour === 12) return 12;
  if (hour >= 7) return hour;
  return hour + 12;
}

/** Normalizes a stated clock time to HH:MM, flagging an unstated AM/PM as a guess. */
export function resolveTime(spec: TimeSpec): { hhmm: string; guess?: string } {
  if (!Number.isInteger(spec.hour) || spec.hour < 0 || spec.hour > 23) {
    throw new RangeError(`Invalid hour ${spec.hour}: expected 0-23`);
  }
  if (!Number.isInteger(spec.minute) || spec.minute < 0 || spec.minute > 59) {
    throw new RangeError(`Invalid minute ${spec.minute}: expected 0-59`);
  }
  if (spec.meridiem === 'am' || spec.meridiem === 'pm') {
    if (spec.hour < 1 || spec.hour > 12) {
      throw new RangeError(`Invalid ${spec.meridiem} hour ${spec.hour}: expected 1-12`);
    }
    const hour = spec.meridiem === 'am' ? spec.hour % 12 : (spec.hour % 12) + 12;
    return { hhmm: `${pad2(hour)}:${pad2(spec.minute)}` };
  }
  if (spec.hour === 0 || spec.hour >= 13) {
    return { hhmm: `${pad2(spec.hour)}:${pad2(spec.minute)}` };
  }
  return { hhmm: `${pad2(guessUnspecified(spec.hour))}:${pad2(spec.minute)}`, guess: 'AM/PM not stated' };
}

/** ISO-8601 string for a local wall time, with the zone's real offset (DST included). */
export function zonedIso(ymd: string, hhmm: string, timeZone: string): string {
  const date = parseYmd(ymd);
  parseHhmm(hhmm);
  const dayStart = startOfLocalDay(date.y, date.m, date.d, timeZone);
  const instant = nextDailyRun(new Date(dayStart.getTime() - 1), hhmm, timeZone);
  const wall = wallClock(instant, timeZone);
  const offsetMinutes = Math.round(
    (Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm) - instant.getTime()) / HHMM_UNIT_MS,
  );
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
  return `${String(wall.y).padStart(4, '0')}-${pad2(wall.m)}-${pad2(wall.d)}T${pad2(wall.hh)}:${pad2(wall.mm)}:00${offset}`;
}

/** Adds (or subtracts) minutes on a local wall clock, rolling over days. */
export function addMinutes(ymd: string, hhmm: string, minutes: number): { ymd: string; hhmm: string } {
  if (!Number.isInteger(minutes)) throw new RangeError(`Invalid minute delta ${minutes}: expected an integer`);
  const date = parseYmd(ymd);
  const time = parseHhmm(hhmm);
  const shifted = new Date(Date.UTC(date.y, date.m - 1, date.d, time.hh, time.mm + minutes));
  return {
    ymd: formatYmd({ y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() }),
    hhmm: `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`,
  };
}

const weekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

export const dateSpecSchema: z.ZodType<DateSpec> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('date'),
    date: z.string().describe('Calendar date exactly as stated by the owner, "YYYY-MM-DD".'),
  }),
  z.object({
    kind: z.literal('offset'),
    days: z.number().int().min(-7).max(60).describe('0 today, 1 tomorrow, 2 the day after, -1 yesterday.'),
  }),
  z.object({
    kind: z.literal('weekday'),
    weekday: weekdaySchema.describe('Weekday; weeks start on Monday.'),
    week: z
      .enum(['this', 'next', 'nearest'])
      .describe('"this" = current Monday-Sunday week, "next" = following week, "nearest" = next occurrence.'),
  }),
  z.object({
    kind: z.literal('month_day'),
    month: z.number().int().min(1).max(12).describe('Month number, 1-12.'),
    day: z.number().int().min(1).max(31).describe('Day of month; the year was not stated.'),
  }),
]);

export const timeSpecSchema: z.ZodType<TimeSpec> = z.object({
  hour: z.number().int().min(0).max(23).describe('Hour as stated, 0-23.'),
  minute: z.number().int().min(0).max(59).describe('Minute, 0-59.'),
  meridiem: z
    .enum(['am', 'pm', 'unspecified'])
    .describe('"unspecified" when the owner did not say AM or PM; the code then guesses.'),
});
