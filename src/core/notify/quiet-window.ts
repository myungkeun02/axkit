import { nextDailyRun, wallClock } from '../scheduler/next-run.js';

export interface QuietHours {
  /** "HH:MM" in the owner's time zone. */
  from: string;
  /** "HH:MM"; may be earlier than `from` (the window crosses midnight). Equal to `from` means never quiet. */
  to: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(value: string): number {
  const match = HHMM.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new RangeError(`Invalid quiet-hours time "${value}": expected HH:MM`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** True when `at` falls inside the quiet window in `timeZone`. */
export function isQuietAt(quiet: QuietHours | undefined, at: Date, timeZone: string): boolean {
  if (quiet === undefined) return false;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  if (from === to) return false;
  const clock = wallClock(at, timeZone);
  const current = clock.hh * 60 + clock.mm;
  return from < to ? current >= from && current < to : current >= from || current < to;
}

/** The next instant the quiet window closes. Only meaningful while `at` is inside it. */
export function quietWindowEnd(quiet: QuietHours, at: Date, timeZone: string): Date {
  if (minutesOf(quiet.from) === minutesOf(quiet.to)) {
    throw new RangeError('Quiet hours with identical from and to never apply');
  }
  return nextDailyRun(at, quiet.to, timeZone);
}
