import type { CalendarEvent, CalendarInfo, CalendarList, CalendarReader, CalendarWriter, EventDraft, TimeRange } from '../../core/contracts/calendar.js';
import { joinId, splitId } from './accounts.js';
import { fromAll } from './account-services.js';
import type { AccountService } from './account-services.js';

type Calendar = CalendarReader & CalendarWriter;

/**
 * Calendars of every connected account, merged by start time. A new event goes on the calendar the draft names (an
 * added account's calendar ids carry its slot, "a2~<id>"), else the first account's main calendar.
 */
export class MultiCalendar implements CalendarReader, CalendarWriter {
  constructor(private readonly accounts: () => Promise<AccountService<Calendar>[]>) {}

  async listEvents(range: TimeRange): Promise<CalendarEvent[]> {
    const all = await this.accounts();
    if (all.length === 1 && all[0] !== undefined) return await all[0].service.listEvents(range);
    const found = await fromAll(all, async (item) => await item.service.listEvents(range));
    return found
      .flatMap(({ item, value }) => value.map((event) => ({ ...event, id: joinId(item.account.key, event.id), account: item.label })))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  async calendars(): Promise<CalendarList> {
    const all = await this.accounts();
    const multi = all.length > 1;
    const lists = await fromAll(all, async (item) => (item.service.calendars !== undefined ? await item.service.calendars() : { calendars: [] }));
    const calendars: CalendarInfo[] = lists.flatMap(({ item, value }) =>
      value.calendars.map((calendar) => ({ ...calendar, id: joinId(item.account.key, calendar.id), ...(multi ? { account: item.label } : {}) })),
    );
    return { calendars, ...(lists.some(({ value }) => value.limited === true) ? { limited: true } : {}) };
  }

  async createEvent(draft: EventDraft): Promise<CalendarEvent> {
    const all = await this.accounts();
    const first = all[0];
    if (first === undefined) throw new Error('연결된 구글 계정이 없어요.');
    if (draft.calendar === undefined || draft.calendar.trim() === '') return await first.service.createEvent(draft);
    // an id names its account; a name is looked up across accounts, the first account first
    const { key, id } = splitId(draft.calendar.trim());
    if (key !== '') {
      const owner = all.find((item) => item.account.key === key);
      if (owner === undefined) throw new Error('그 캘린더가 있던 구글 계정이 지금은 연결돼 있지 않아요.');
      return { ...(await owner.service.createEvent({ ...draft, calendar: id })), ...(all.length > 1 ? { account: owner.label } : {}) };
    }
    if (all.length > 1) {
      const wanted = id.toLowerCase();
      for (const item of all) {
        const list = item.service.calendars !== undefined ? await item.service.calendars().catch(() => undefined) : undefined;
        if (list?.calendars.some((calendar) => calendar.writable && (calendar.id.toLowerCase() === wanted || calendar.name.toLowerCase() === wanted))) {
          return { ...(await item.service.createEvent({ ...draft, calendar: id })), account: item.label };
        }
      }
    }
    return await first.service.createEvent({ ...draft, calendar: id });
  }
}
