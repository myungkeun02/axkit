import { z } from 'zod';
import type { CalendarEvent, CalendarReader, CalendarWriter, EventDraft } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import { addMinutes, dateSpecSchema, timeSpecSchema, zonedIso } from '../../core/time/date-spec.js';
import { dateMentioned, evidenceFound, normalizeText, timeMentioned } from '../../core/time/evidence.js';
import { formatEventLocal } from './format.js';
import type { CalendarTexts } from './locale.js';
import { guessNote, resolveWhen } from './resolve.js';

const DUPLICATE_WINDOW_MS = 90 * 60_000;

const EVIDENCE_HINT =
  "Verbatim quote of the words that state the date and time, copied from the owner's message or a mail you read; " +
  'never paraphrase. Give the date as a DateSpec (offset/weekday/month_day/date) instead of computing dates yourself.';

const addInput = z.object({
  title: z.string().min(1).max(100).describe('Short event title.'),
  date: dateSpecSchema,
  time: timeSpecSchema.optional().describe('Omit for an all-day event.'),
  durationMinutes: z.number().int().min(5).max(1440).optional().describe('Defaults to 60.'),
  location: z.string().min(1).max(200).optional(),
  attendees: z.array(z.email()).max(20).optional().describe('Email addresses; invitations are sent to them.'),
  calendar: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'When the owner has more than one calendar (calendar.calendars): the one this event belongs on, by its id or name. ' +
        'Judge by the calendar names and descriptions and by where similar events already are (calendar.list_events shows each event\'s calendar), ' +
        'e.g. a work meeting on a "biz"/company calendar, a family dinner on a personal one. An explicit choice by the owner always wins. Omit for the main calendar.',
    ),
  evidence: z.string().min(2).max(300).describe(EVIDENCE_HINT),
});

export type AddEventInput = z.infer<typeof addInput>;

export type AddEventOutput =
  | { status: 'created'; event: CalendarEvent }
  | { status: 'duplicate'; existing: CalendarEvent };

interface AddDeps {
  reader: CalendarReader;
  writer: CalendarWriter;
  now: () => Date;
  timeZone: string;
  texts: CalendarTexts;
}

interface DraftTimes {
  start: string;
  end: string;
  allDay: boolean;
}

function draftTimes(ymd: string, hhmm: string | undefined, durationMinutes: number, timeZone: string): DraftTimes {
  if (hhmm === undefined) {
    return { start: ymd, end: addMinutes(ymd, '00:00', 1440).ymd, allDay: true };
  }
  const end = addMinutes(ymd, hhmm, durationMinutes);
  return { start: zonedIso(ymd, hhmm, timeZone), end: zonedIso(end.ymd, end.hhmm, timeZone), allDay: false };
}

function titlesMatch(a: string, b: string): boolean {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (left.length === 0 || right.length === 0) return false;
  return left.includes(right) || right.includes(left);
}

function isDuplicate(
  event: CalendarEvent,
  target: { title: string; ymd: string; allDay: boolean; startMs: number },
): boolean {
  if (!titlesMatch(event.title, target.title)) return false;
  if (target.allDay) return event.allDay && event.start.slice(0, 10) === target.ymd;
  if (event.allDay) return false;
  const existingMs = Date.parse(event.start);
  return Number.isFinite(existingMs) && Math.abs(existingMs - target.startMs) <= DUPLICATE_WINDOW_MS;
}

function rejection(input: AddEventInput, grounding: readonly string[]): string | undefined {
  if (!evidenceFound(input.evidence, grounding)) {
    return "evidence was not found in this turn; quote the owner's words exactly";
  }
  if (!dateMentioned(input.date, input.evidence)) return 'the date is not mentioned in the evidence';
  if (input.time !== undefined && !timeMentioned(input.time, input.evidence)) {
    return 'the time is not mentioned in the evidence';
  }
  return undefined;
}

/** Tool "calendar.add_event": writes the owner's calendar and invites attendees with a second effect. */
export function addEventTool(deps: AddDeps): Tool<AddEventInput, AddEventOutput> {
  return {
    name: 'calendar.add_event',
    description:
      "Create an event on the owner's calendar. The evidence must be a verbatim quote from this turn that states " +
      'the date and time. Relative dates must be given as a DateSpec; the code resolves them in the owner zone.',
    input: addInput,
    effects: ['write'],
    effectsFor: (input) => (input.attendees !== undefined && input.attendees.length > 0 ? ['send'] : []),
    reject: (input, call) => rejection(input, call.grounding),
    uncertainty: (input) => {
      const when = resolveWhen(input.date, input.time, deps.now(), deps.timeZone);
      return guessNote(when.guesses, deps.texts);
    },
    describe(input) {
      const when = resolveWhen(input.date, input.time, deps.now(), deps.timeZone);
      const times = draftTimes(when.ymd, when.hhmm, input.durationMinutes ?? 60, deps.timeZone);
      const lines = [input.title, formatEventLocal(times, deps.timeZone, deps.texts)];
      if (input.location !== undefined) lines.push(`${deps.texts.locationLabel}: ${input.location}`);
      if (input.attendees !== undefined && input.attendees.length > 0) {
        lines.push(`${deps.texts.attendeesLabel}: ${input.attendees.join(', ')} — ${deps.texts.inviteNote}`);
      }
      if (input.calendar !== undefined) lines.push(`${deps.texts.calendarLabel}: ${input.calendar}`);
      lines.push(`${deps.texts.evidenceLabel}: "${input.evidence}"`);
      return lines.join('\n');
    },
    async run(input) {
      const when = resolveWhen(input.date, input.time, deps.now(), deps.timeZone);
      const times = draftTimes(when.ymd, when.hhmm, input.durationMinutes ?? 60, deps.timeZone);
      const dayEnd = addMinutes(when.ymd, '00:00', 1440).ymd;
      const existing = await deps.reader.listEvents({
        from: new Date(zonedIso(when.ymd, '00:00', deps.timeZone)),
        to: new Date(zonedIso(dayEnd, '00:00', deps.timeZone)),
      });
      const duplicate = existing.find((event) =>
        isDuplicate(event, {
          title: input.title,
          ymd: when.ymd,
          allDay: times.allDay,
          startMs: Date.parse(times.start),
        }),
      );
      if (duplicate !== undefined) return { status: 'duplicate', existing: duplicate };

      const draft: EventDraft = {
        title: input.title,
        start: times.start,
        end: times.end,
        allDay: times.allDay,
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.attendees !== undefined ? { attendees: input.attendees } : {}),
        ...(input.calendar !== undefined ? { calendar: input.calendar } : {}),
      };
      return { status: 'created', event: await deps.writer.createEvent(draft) };
    },
  };
}
