import type {
  CalendarEvent,
  CalendarReader,
  CalendarWriter,
  EventDraft,
  TimeRange,
} from '../../core/contracts/calendar.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const MAX_RESULTS = 50;

export interface GoogleCalendarOptions {
  request: GoogleRequestFn;
  /** The assistant's IANA zone, sent with timed events. */
  timeZone: string;
}

interface EventTime {
  time: string;
  dateOnly: boolean;
}

function readTime(value: unknown): EventTime | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.dateTime === 'string' && value.dateTime !== '') return { time: value.dateTime, dateOnly: false };
  if (typeof value.date === 'string' && value.date !== '') return { time: value.date, dateOnly: true };
  return undefined;
}

function toEvent(raw: unknown): CalendarEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.status === 'cancelled') return undefined;
  if (typeof raw.id !== 'string' || raw.id === '') return undefined;
  const start = readTime(raw.start);
  const end = readTime(raw.end);
  if (start === undefined || end === undefined) return undefined;

  const attendees = Array.isArray(raw.attendees)
    ? raw.attendees.flatMap((attendee) =>
        isRecord(attendee) && typeof attendee.email === 'string' && attendee.email !== '' ? [attendee.email] : [],
      )
    : [];

  return {
    id: raw.id,
    title: typeof raw.summary === 'string' ? raw.summary : '',
    start: start.time,
    end: end.time,
    allDay: start.dateOnly,
    ...(typeof raw.location === 'string' && raw.location !== '' ? { location: raw.location } : {}),
    ...(attendees.length > 0 ? { attendees } : {}),
    ...(typeof raw.htmlLink === 'string' && raw.htmlLink !== '' ? { url: raw.htmlLink } : {}),
  };
}

/** Google Calendar adapter for the primary calendar. */
export class GoogleCalendar implements CalendarReader, CalendarWriter {
  constructor(private readonly deps: GoogleCalendarOptions) {}

  async listEvents(range: TimeRange): Promise<CalendarEvent[]> {
    const url = new URL(CALENDAR_BASE);
    url.searchParams.set('timeMin', range.from.toISOString());
    url.searchParams.set('timeMax', range.to.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', String(MAX_RESULTS));

    const payload = await this.deps.request<{ items?: unknown[] }>(url.toString());
    const items = Array.isArray(payload.items) ? payload.items : [];
    return items.map(toEvent).filter((event): event is CalendarEvent => event !== undefined);
  }

  async createEvent(draft: EventDraft): Promise<CalendarEvent> {
    const attendees = draft.attendees ?? [];
    const url = new URL(CALENDAR_BASE);
    url.searchParams.set('sendUpdates', attendees.length > 0 ? 'all' : 'none');

    const body = {
      summary: draft.title,
      start: this.timeField(draft.start, draft.allDay),
      end: this.timeField(draft.end, draft.allDay),
      ...(draft.location !== undefined && draft.location !== '' ? { location: draft.location } : {}),
      ...(draft.description !== undefined && draft.description !== '' ? { description: draft.description } : {}),
      ...(attendees.length > 0 ? { attendees: attendees.map((email) => ({ email })) } : {}),
    };

    const created = await this.deps.request<unknown>(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const event = toEvent(created);
    if (event === undefined) throw new Error('Google Calendar did not return the created event.');
    return event;
  }

  private timeField(value: string, allDay: boolean): { date: string } | { dateTime: string; timeZone: string } {
    return allDay
      ? { date: value.slice(0, 10) }
      : { dateTime: value, timeZone: this.deps.timeZone };
  }
}
