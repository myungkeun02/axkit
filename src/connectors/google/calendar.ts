import type {
  CalendarEvent,
  CalendarInfo,
  CalendarList,
  CalendarReader,
  CalendarWriter,
  EventDraft,
  TimeRange,
} from '../../core/contracts/calendar.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';

const API = 'https://www.googleapis.com/calendar/v3';
const LIST_URL = `${API}/users/me/calendarList?minAccessRole=reader&maxResults=100`;
const MAX_RESULTS = 50;
/** More than this many shown calendars and the rest are left out of a listing (each one is a request). */
const MAX_CALENDARS = 15;
const LIST_TTL_MS = 10 * 60_000;
const PRIMARY: CalendarInfo = { id: 'primary', name: '기본 캘린더', primary: true, writable: true };

const eventsUrl = (calendarId: string): string => `${API}/calendars/${encodeURIComponent(calendarId)}/events`;

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

interface ShownCalendar extends CalendarInfo {
  shown: boolean;
}

function toCalendar(raw: unknown): ShownCalendar | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') return undefined;
  const name = typeof raw.summaryOverride === 'string' && raw.summaryOverride !== '' ? raw.summaryOverride : typeof raw.summary === 'string' ? raw.summary : raw.id;
  const primary = raw.primary === true;
  return {
    id: primary ? 'primary' : raw.id,
    name,
    primary,
    writable: raw.accessRole === 'owner' || raw.accessRole === 'writer',
    ...(typeof raw.description === 'string' && raw.description.trim() !== '' ? { description: raw.description.trim().slice(0, 200) } : {}),
    // what the owner has checked in Google Calendar; the main one always counts
    shown: primary || (raw.selected === true && raw.hidden !== true),
  };
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

/**
 * Google Calendar over every calendar the owner shows (checked in the calendar list), not only the main one; new
 * events go on the calendar the draft names, else the main one. Listing calendars needs the calendar-list permission:
 * without it only the main calendar is read and `calendars()` says so (`limited`).
 */
export class GoogleCalendar implements CalendarReader, CalendarWriter {
  private list: { at: number; calendars: ShownCalendar[]; limited: boolean } | undefined;

  constructor(private readonly deps: GoogleCalendarOptions & { now?: () => number }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async known(): Promise<{ calendars: ShownCalendar[]; limited: boolean }> {
    if (this.list !== undefined && this.now() - this.list.at < LIST_TTL_MS) return this.list;
    let calendars: ShownCalendar[];
    let limited = false;
    try {
      const payload = await this.deps.request<{ items?: unknown[] }>(LIST_URL);
      calendars = (Array.isArray(payload.items) ? payload.items : []).map(toCalendar).filter((item): item is ShownCalendar => item !== undefined);
      if (!calendars.some((item) => item.primary)) calendars.unshift({ ...PRIMARY, shown: true });
    } catch {
      // usually a sign-in from before the calendar-list permission: the main calendar still works
      calendars = [{ ...PRIMARY, shown: true }];
      limited = true;
    }
    calendars.sort((a, b) => Number(b.primary) - Number(a.primary));
    this.list = { at: this.now(), calendars, limited };
    return this.list;
  }

  async calendars(): Promise<CalendarList> {
    const { calendars, limited } = await this.known();
    return {
      calendars: calendars.filter((item) => item.shown).map((item): CalendarInfo => ({ id: item.id, name: item.name, primary: item.primary, writable: item.writable, ...(item.description !== undefined ? { description: item.description } : {}) })),
      ...(limited ? { limited: true } : {}),
    };
  }

  async listEvents(range: TimeRange): Promise<CalendarEvent[]> {
    const shown = (await this.known()).calendars.filter((item) => item.shown).slice(0, MAX_CALENDARS);
    const named = shown.length > 1;
    const results = await Promise.allSettled(shown.map(async (calendar) => ({ calendar, events: await this.eventsOf(calendar.id, range) })));
    const ok = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const failed = results.find((result) => result.status === 'rejected');
    // the main calendar failing is a real failure; another one failing only leaves it out
    if (failed !== undefined && !ok.some((item) => item.calendar.primary)) throw failed.reason;
    const seen = new Set<string>();
    const events: CalendarEvent[] = [];
    for (const { calendar, events: own } of ok) {
      for (const { event, uid } of own) {
        // the same meeting on two calendars (invited on the main one, copied to a shared one) shows once
        const key = uid ?? `${calendar.id}:${event.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(named ? { ...event, calendar: calendar.name } : event);
      }
    }
    return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  private async eventsOf(calendarId: string, range: TimeRange): Promise<{ event: CalendarEvent; uid?: string }[]> {
    const url = new URL(eventsUrl(calendarId));
    url.searchParams.set('timeMin', range.from.toISOString());
    url.searchParams.set('timeMax', range.to.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', String(MAX_RESULTS));
    const payload = await this.deps.request<{ items?: unknown[] }>(url.toString());
    const items = Array.isArray(payload.items) ? payload.items : [];
    return items.flatMap((raw) => {
      const event = toEvent(raw);
      if (event === undefined) return [];
      const uid = isRecord(raw) && typeof raw.iCalUID === 'string' && raw.iCalUID !== '' ? raw.iCalUID : undefined;
      return [{ event, ...(uid !== undefined ? { uid } : {}) }];
    });
  }

  /** The calendar a draft names (its id or name, any case); the main one when it names none. */
  private async target(name: string | undefined): Promise<CalendarInfo> {
    if (name === undefined || name.trim() === '' || name === 'primary') return PRIMARY;
    const wanted = name.trim().toLowerCase();
    const { calendars } = await this.known();
    const writable = calendars.filter((item) => item.writable);
    const found = writable.find((item) => item.id.toLowerCase() === wanted) ?? writable.find((item) => item.name.toLowerCase() === wanted) ?? writable.find((item) => item.name.toLowerCase().includes(wanted));
    if (found === undefined) {
      throw new Error(`"${name}" 캘린더가 없거나 일정을 넣을 수 없는 캘린더예요. 넣을 수 있는 캘린더: ${writable.map((item) => item.name).join(', ') || '기본 캘린더'}`);
    }
    return found;
  }

  async createEvent(draft: EventDraft): Promise<CalendarEvent> {
    const attendees = draft.attendees ?? [];
    const calendar = await this.target(draft.calendar);
    const url = new URL(eventsUrl(calendar.id));
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
    return { ...event, calendar: calendar.name };
  }

  private timeField(value: string, allDay: boolean): { date: string } | { dateTime: string; timeZone: string } {
    return allDay
      ? { date: value.slice(0, 10) }
      : { dateTime: value, timeZone: this.deps.timeZone };
  }
}
