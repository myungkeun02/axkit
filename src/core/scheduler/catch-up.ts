import type { JobRun, Schedule } from './types.js';
import { nextDailyRun } from './next-run.js';

/** A daily run missed while the server was off is still worth doing this long after its time (07:00 briefing at 07:05). */
export const CATCH_UP_GRACE_MS = 3 * 3_600_000;
/** How often the scheduler compares its plan with the wall clock, so timers armed before a Mac sleep still fire on time. */
export const WALL_CHECK_MS = 60_000;

/** The latest instant at or before `now` whose wall clock reads the daily time. */
export function previousDailyDue(now: Date, at: string, timeZone: string): Date {
  let due = nextDailyRun(new Date(now.getTime() - 26 * 3_600_000), at, timeZone);
  for (;;) {
    const next = nextDailyRun(due, at, timeZone);
    if (next.getTime() > now.getTime()) return due;
    due = next;
  }
}

/**
 * The missed daily due time to run at start, if any: within the grace window and later than the last stored run.
 * Without a stored run nothing is caught up, so a fresh install does not fire every daily job at once.
 */
export function missedDailyDue(
  schedule: Schedule,
  now: Date,
  timeZone: string,
  lastRun: JobRun | undefined,
): Date | undefined {
  if (schedule.kind !== 'daily' || lastRun === undefined) return undefined;
  const due = previousDailyDue(now, schedule.at, timeZone);
  if (due.getTime() > now.getTime() || now.getTime() - due.getTime() > CATCH_UP_GRACE_MS) return undefined;
  const last = Date.parse(lastRun.startedAt);
  if (!Number.isFinite(last) || last >= due.getTime()) return undefined;
  return due;
}

/**
 * The next due time after `previousDue`, skipping every tick already in the past: after a sleep or a long run the
 * missed ticks coalesce into the one that just ran instead of firing one after another. Interval jobs keep their phase.
 */
export function nextDueAfter(schedule: Schedule, previousDue: number, now: number, timeZone: string): number {
  if (schedule.kind === 'every') {
    const step = schedule.seconds * 1000;
    const next = previousDue + step;
    if (next > now) return next;
    return previousDue + (Math.floor((now - previousDue) / step) + 1) * step;
  }
  return nextDailyRun(new Date(Math.max(previousDue, now)), schedule.at, timeZone).getTime();
}
