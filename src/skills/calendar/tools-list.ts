import { z } from 'zod';
import type { CalendarReader } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import { addMinutes, dateSpecSchema, resolveDate, zonedIso } from '../../core/time/date-spec.js';
import { formatEventLocal } from './format.js';
import type { CalendarTexts } from './locale.js';

const listInput = z.object({
  date: dateSpecSchema,
  days: z.number().int().min(1).max(14).optional().describe('Number of days to list, starting at that day. Defaults to 1.'),
});

export type ListEventsInput = z.infer<typeof listInput>;

export interface ListedEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** The owner's account it is on, when more than one is connected. */
  account?: string;
  attendees?: readonly string[];
  /** Human-readable local range, e.g. "11월 20일 (금) 15:00–16:00". */
  local: string;
}

interface ListDeps {
  reader: CalendarReader;
  now: () => Date;
  timeZone: string;
  texts: CalendarTexts;
}

/** Tool "calendar.list_events": reads only, so it never asks for approval. */
export function listEventsTool(deps: ListDeps): Tool<ListEventsInput, ListedEvent[]> {
  return {
    name: 'calendar.list_events',
    description:
      "List the owner's calendar events from the start of the given local day, for up to 14 days. " +
      'Times are ISO 8601 with offset; use DateSpec for the date instead of computing it yourself.',
    input: listInput,
    effects: ['read'],
    async run(input) {
      const days = input.days ?? 1;
      const startYmd = resolveDate(input.date, deps.now(), deps.timeZone).ymd;
      const endYmd = addMinutes(startYmd, '00:00', days * 1440).ymd;
      const events = await deps.reader.listEvents({
        from: new Date(zonedIso(startYmd, '00:00', deps.timeZone)),
        to: new Date(zonedIso(endYmd, '00:00', deps.timeZone)),
      });
      return [...events]
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((event) => ({
          id: event.id,
          title: event.title,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          ...(event.location !== undefined ? { location: event.location } : {}),
          ...(event.account !== undefined ? { account: event.account } : {}),
          ...(event.attendees !== undefined ? { attendees: event.attendees } : {}),
          local: formatEventLocal(event, deps.timeZone, deps.texts),
        }));
    },
  };
}
