import { z } from 'zod';
import { Contracts } from '../../../core/contracts/index.js';
import type { CalendarEvent } from '../../../core/contracts/index.js';
import type { AppView } from '../../../core/contracts/device-api.js';
import { ViewInputError } from '../../../core/contracts/device-api.js';
import type { PluginContext } from '../../../core/plugin/types.js';
import type { Geo, GeoCache } from './routes.js';
import { lastDayOfMonth, monthOf, monthRange, ymdOf, ymdPlus } from '../../../core/time/local-day.js';

const querySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    allDay: z.boolean(),
    start: z.string().min(10).max(40),
    end: z.string().min(10).max(40).optional(),
    place: z.string().trim().max(200).optional(),
  })
  .refine((v) => (v.allDay ? DATE.test(v.start) && (v.end === undefined || DATE.test(v.end)) : !Number.isNaN(Date.parse(v.start)) && (v.end === undefined || !Number.isNaN(Date.parse(v.end)))))
  .refine((v) => v.end === undefined || (v.allDay ? v.end > v.start : Date.parse(v.end) > Date.parse(v.start)));

interface DayView {
  date: string;
  events: { id: string; title: string; start: string; end?: string; allDay?: boolean; place?: string; geo?: Geo }[];
  done: { id: string; title: string; at: string; bot?: { id: string; name: string }; team?: string; detail?: string }[];
}

function dayOfEvent(event: CalendarEvent, zone: string): string {
  return event.allDay ? event.start.slice(0, 10) : ymdOf(new Date(event.start), zone);
}

/**
 * View "calendar" (R5): one month, every day present, with the schedule (calendar connector, when connected) and what
 * the assistant and its bots did (the work log). Either half is simply empty when its source is missing.
 */
/** `geo` (D7): coordinates of each event's place, when Kakao Local is connected. */
export function calendarView(ctx: PluginContext, geo?: GeoCache): AppView {
  const zone = ctx.assistant.timezone;
  const writer = ctx.tryUse(Contracts.calendarWrite);
  return {
    name: 'calendar',
    version: 1,
    // the owner's own event, no guests: a reversible write to their calendar, so no card (invites go through chat)
    ...(writer !== undefined
      ? {
          actions: {
            async add(body: unknown) {
              const parsed = addSchema.safeParse(body);
              if (!parsed.success) throw new ViewInputError('shape');
              const v = parsed.data;
              const end = v.end ?? (v.allDay ? ymdPlus(v.start, 1) : new Date(Date.parse(v.start) + 3_600_000).toISOString());
              const event = await writer.createEvent({
                title: v.title,
                start: v.start,
                end,
                allDay: v.allDay,
                ...(v.place !== undefined && v.place !== '' ? { location: v.place } : {}),
              });
              await ctx.tryUse(Contracts.workLog)?.add({ at: ctx.clock.now(), title: `일정 추가: ${v.title}`, kind: 'action' }).catch(() => undefined);
              return { id: event.id };
            },
          },
        }
      : {}),
    async read(query) {
      const parsed = querySchema.safeParse(Object.fromEntries(query));
      if (!parsed.success) throw new ViewInputError('shape');
      const month = parsed.data.month ?? monthOf(ctx.clock.now(), zone);
      const range = monthRange(month, zone);
      const days = new Map<string, DayView>();
      for (let date = `${month}-01`; date <= lastDayOfMonth(month); date = ymdPlus(date, 1)) {
        days.set(date, { date, events: [], done: [] });
      }
      const calendar = ctx.tryUse(Contracts.calendarRead);
      const events = calendar === undefined ? [] : await calendar.listEvents(range).catch(() => []);
      for (const event of events) {
        days.get(dayOfEvent(event, zone))?.events.push({
          id: event.id,
          title: event.title,
          start: event.start,
          end: event.end,
          ...(event.allDay ? { allDay: true } : {}),
          ...(event.location !== undefined ? { place: event.location } : {}),
        });
      }
      const work = ctx.tryUse(Contracts.workLog);
      // D8: which team a bot's work belongs to
      const teamOf = new Map(((await ctx.tryUse(Contracts.bots)?.list().catch(() => [])) ?? []).flatMap((bot) => (bot.team !== undefined ? [[bot.id, bot.team] as const] : [])));
      for (const entry of work === undefined ? [] : await work.between(range.from, range.to).catch(() => [])) {
        const team = entry.bot !== undefined ? teamOf.get(entry.bot.id) : undefined;
        days.get(ymdOf(new Date(entry.at), zone))?.done.push({
          id: entry.id,
          title: entry.title,
          at: entry.at,
          ...(entry.bot !== undefined ? { bot: entry.bot } : {}),
          ...(team !== undefined ? { team } : {}),
          ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        });
      }
      for (const day of days.values()) {
        day.events.sort((a, b) => a.start.localeCompare(b.start));
        if (geo !== undefined) day.events = await geo.decorate(day.events);
      }
      return { month, timezone: zone, days: [...days.values()] };
    },
  };
}
