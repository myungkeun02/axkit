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
}

export interface TimeRange {
  from: Date;
  to: Date;
}

/** Capability "calendar.read". */
export interface CalendarReader {
  listEvents(range: TimeRange): Promise<CalendarEvent[]>;
}

/** Capability "calendar.write". */
export interface CalendarWriter {
  createEvent(draft: EventDraft): Promise<CalendarEvent>;
}
