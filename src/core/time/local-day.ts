import { startOfLocalDay, wallClock } from '../scheduler/next-run.js';

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM = /^(\d{4})-(\d{2})$/;
const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const pad2 = (value: number): string => String(value).padStart(2, '0');
const formatYmd = (y: number, m: number, d: number): string => `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;

function partsOf(ymd: string): { y: number; m: number; d: number } | undefined {
  const match = YMD.exec(ymd);
  if (match === null) return undefined;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** "YYYY-MM-DD" of an instant in the owner's zone. */
export function ymdOf(date: Date, timeZone: string): string {
  const wall = wallClock(date, timeZone);
  return formatYmd(wall.y, wall.m, wall.d);
}

export function ymdPlus(ymd: string, days: number): string {
  const parts = partsOf(ymd);
  if (parts === undefined) return ymd;
  const shifted = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days));
  return formatYmd(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Half-open [start of day, start of the next day) for a calendar date in the owner's zone. */
export function dayRange(ymd: string, timeZone: string): { from: Date; to: Date } {
  const parts = partsOf(ymd);
  const next = partsOf(ymdPlus(ymd, 1));
  if (parts === undefined || next === undefined) return { from: new Date(0), to: new Date(0) };
  return {
    from: startOfLocalDay(parts.y, parts.m, parts.d, timeZone),
    to: startOfLocalDay(next.y, next.m, next.d, timeZone),
  };
}

export function minutesOfDay(at: Date, timeZone: string): number {
  const wall = wallClock(at, timeZone);
  return wall.hh * 60 + wall.mm;
}

/** 0 = Sunday … 6 = Saturday, in the owner's zone. */
export function weekdayOf(at: Date, timeZone: string): number {
  return WEEKDAYS[wallClock(at, timeZone).weekday] ?? 0;
}

/** "YYYY-MM" of an instant in the owner's zone. */
export function monthOf(date: Date, timeZone: string): string {
  return ymdOf(date, timeZone).slice(0, 7);
}

export function monthPlus(ym: string, months: number): string {
  const match = YM.exec(ym);
  if (match === null) return ym;
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + months;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${pad2((index % 12) + 1)}`;
}

/** Last calendar day of a month, "YYYY-MM-DD". */
export function lastDayOfMonth(ym: string): string {
  return ymdPlus(`${monthPlus(ym, 1)}-01`, -1);
}

/** Half-open range covering a whole month in the owner's zone. */
export function monthRange(ym: string, timeZone: string): { from: Date; to: Date } {
  return {
    from: dayRange(`${ym}-01`, timeZone).from,
    to: dayRange(`${monthPlus(ym, 1)}-01`, timeZone).from,
  };
}

/** Whole calendar days from one local date to another (negative when `to` is earlier). */
export function daysFromTo(fromYmd: string, toYmd: string): number {
  const a = partsOf(fromYmd);
  const b = partsOf(toYmd);
  if (a === undefined || b === undefined) return Number.NaN;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}
