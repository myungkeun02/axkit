/** A calendar entry as skills see it. Times are ISO 8601 with offset; all-day entries use dates only. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** "2026-11-20T15:00:00+09:00" or, when allDay, "2026-11-20". */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  attendees?: readonly string[];
  /** Link the owner can open, when the service has one. */
  url?: string;
  /** Which of the owner's accounts it is on (its address), when more than one is connected. */
  account?: string;
  /** The calendar it is on (its name), when the owner has more than one. */
  calendar?: string;
}

/** One of the owner's calendars (Google: those checked in the calendar list). */
export interface CalendarInfo {
  /** What `EventDraft.calendar` takes. */
  id: string;
  name: string;
  primary: boolean;
  /** The owner can add events to it (owner or writer access). */
  writable: boolean;
  description?: string;
  /** The account it belongs to, when more than one is connected. */
  account?: string;
}

export interface CalendarList {
  calendars: CalendarInfo[];
  /** Only the main calendar could be listed (the sign-in lacks the calendar-list permission). */
  limited?: boolean;
}

export interface EventDraft {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  /** Email addresses. Inviting people reaches them, so tools must add the `send` effect. */
  attendees?: readonly string[];
  /** Which calendar (a `CalendarInfo.id` or its name); the main calendar when left out. */
  calendar?: string;
}

export interface TimeRange {
  from: Date;
  to: Date;
}

/** Capability "calendar.read". */
export interface CalendarReader {
  /** Events of every calendar the owner shows, not only the main one. */
  listEvents(range: TimeRange): Promise<CalendarEvent[]>;
  calendars?(): Promise<CalendarList>;
}

/** Capability "calendar.write". */
export interface CalendarWriter {
  createEvent(draft: EventDraft): Promise<CalendarEvent>;
}
