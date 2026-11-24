import type { CalendarEvent } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { startOfLocalDay, wallClock } from '../../core/scheduler/next-run.js';
import type { MemoryTexts } from './locale.js';
import { parseAddress } from './people-keys.js';
import type { PeopleStore } from './people-store.js';

export const CALENDAR_JOB = 'memory.people.calendar';
export const CALENDAR_AT = '23:10';

const SUMMARY_CHARS = 80;

interface DayRange {
  from: Date;
  to: Date;
}

function localDay(now: Date, timeZone: string): DayRange {
  const wall = wallClock(now, timeZone);
  const next = new Date(Date.UTC(wall.y, wall.m - 1, wall.d + 1));
  return {
    from: startOfLocalDay(wall.y, wall.m, wall.d, timeZone),
    to: startOfLocalDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
  };
}

function eventInstant(event: CalendarEvent, now: Date): Date {
  const parsed = new Date(event.start);
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}

async function noteDay(
  ctx: PluginContext,
  people: PeopleStore,
  texts: MemoryTexts,
  now: Date,
): Promise<void> {
  const calendar = ctx.tryUse(Contracts.calendarRead);
  if (calendar === undefined) return;
  const range = localDay(now, ctx.assistant.timezone);
  let events: readonly CalendarEvent[];
  try {
    events = await calendar.listEvents(range);
  } catch (error) {
    ctx.log.warn('memory: calendar events could not be loaded', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  for (const event of events) {
    const summary = `${texts.meetingPrefix}${event.title}`.slice(0, SUMMARY_CHARS);
    const at = eventInstant(event, now).toISOString();
    for (const attendee of event.attendees ?? []) {
      const identity = parseAddress(attendee);
      if (identity.name === undefined && identity.email === undefined) continue;
      await people.noteInteraction(identity, { at, channel: 'calendar', summary, ref: event.id });
    }
  }
}

/** Registers the end-of-day calendar sweep that records who the owner met. */
export function registerCalendarSweep(ctx: PluginContext, people: PeopleStore, texts: MemoryTexts): void {
  ctx.scheduler.add({
    name: CALENDAR_JOB,
    schedule: { kind: 'daily', at: CALENDAR_AT },
    async run(now) {
      await noteDay(ctx, people, texts, now);
    },
  });
}
