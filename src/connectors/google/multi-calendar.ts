import type { CalendarEvent, CalendarReader, CalendarWriter, EventDraft, TimeRange } from '../../core/contracts/calendar.js';
import { joinId } from './accounts.js';
import { fromAll } from './account-services.js';
import type { AccountService } from './account-services.js';

/** Calendars of every connected account, merged by start time; new events go on the first account's calendar. */
export class MultiCalendar implements CalendarReader, CalendarWriter {
  constructor(
    private readonly accounts: () => Promise<AccountService<CalendarReader>[]>,
    private readonly writer: CalendarWriter,
  ) {}

  async listEvents(range: TimeRange): Promise<CalendarEvent[]> {
    const all = await this.accounts();
    if (all.length === 1 && all[0] !== undefined) return await all[0].service.listEvents(range);
    const found = await fromAll(all, async (item) => await item.service.listEvents(range));
    return found
      .flatMap(({ item, value }) => value.map((event) => ({ ...event, id: joinId(item.account.key, event.id), account: item.label })))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  async createEvent(draft: EventDraft): Promise<CalendarEvent> {
    return await this.writer.createEvent(draft);
  }
}
