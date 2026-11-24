import type { CalendarEvent } from '../../core/contracts/index.js';
import { wallClock } from '../../core/scheduler/next-run.js';
import { dayRange, minutesOfDay, ymdOf, ymdPlus } from '../../core/time/local-day.js';

export { dayRange, minutesOfDay, ymdOf, ymdPlus };

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export interface LocalDay {
  /** "YYYY-MM-DD" in the owner's zone. */
  ymd: string;
  from: Date;
  to: Date;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function todayDay(now: Date, timeZone: string): LocalDay {
  const ymd = ymdOf(now, timeZone);
  return { ymd, ...dayRange(ymd, timeZone) };
}

export function tomorrowDay(now: Date, timeZone: string): LocalDay {
  const ymd = ymdPlus(ymdOf(now, timeZone), 1);
  return { ymd, ...dayRange(ymd, timeZone) };
}

export function minutesOfTime(hhmm: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (match === null) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "HH:MM" in the owner's zone for an ISO instant, or undefined when it cannot be parsed. */
export function hhmmOf(iso: string, timeZone: string): string | undefined {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return undefined;
  const wall = wallClock(instant, timeZone);
  return `${pad2(wall.hh)}:${pad2(wall.mm)}`;
}

export function startMsOf(event: CalendarEvent): number {
  const ms = Date.parse(event.start);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/** The local calendar day a to-do due value ("YYYY-MM-DD" or offset date-time) points at. */
export function dueDay(due: string | undefined, timeZone: string): string | undefined {
  if (due === undefined) return undefined;
  if (YMD.test(due)) return due;
  const instant = new Date(due);
  if (Number.isNaN(instant.getTime())) return undefined;
  return ymdOf(instant, timeZone);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}
