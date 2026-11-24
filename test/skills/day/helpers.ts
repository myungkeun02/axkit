import type {
  CalendarEvent,
  CalendarReader,
  Fact,
  GeoPoint,
  MailAwaitingReply,
  MailMessage,
  MailQuery,
  MailReader,
  MailSummary,
  MemoryWriter,
  Notice,
  NoticeResult,
  Notifier,
  PeopleReader,
  PersonSummary,
  PhoneDayTotals,
  PhoneLocation,
  PhoneSignals,
  PlaceSource,
  RememberInput,
  TimeRange,
  TodoDraft,
  TodoItem,
  TodoReader,
  TodoWriter,
} from '../../../src/core/contracts/index.js';
import type { OutgoingMessage } from '../../../src/core/conversation/types.js';
import type { Replier } from '../../../src/core/conversation/types.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');

export class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

export class FakeReplier implements Replier {
  readonly replies: { to: unknown; message: OutgoingMessage }[] = [];
  async reply(to: unknown, message: OutgoingMessage): Promise<void> {
    this.replies.push({ to, message });
  }
}

export class FakeCalendarReader implements CalendarReader {
  readonly ranges: TimeRange[] = [];
  constructor(private readonly list: (range: TimeRange) => readonly CalendarEvent[] = () => []) {}
  async listEvents(range: TimeRange): Promise<CalendarEvent[]> {
    this.ranges.push(range);
    return [...this.list(range)];
  }
}

export class FakeTodoReader implements TodoReader {
  constructor(
    public openItems: TodoItem[] = [],
    public completed: TodoItem[] = [],
  ) {}
  async open(): Promise<TodoItem[]> {
    return [...this.openItems];
  }
  async doneSince(since: Date): Promise<TodoItem[]> {
    return this.completed.filter((item) => item.completedAt !== undefined && Date.parse(item.completedAt) >= since.getTime());
  }
}

export class FakeTodoWriter implements TodoWriter {
  readonly drafts: TodoDraft[] = [];
  private nextId = 1;
  async add(draft: TodoDraft): Promise<TodoItem> {
    this.drafts.push(draft);
    return { id: `t${this.nextId++}`, done: false, createdAt: NOW.toISOString(), ...draft };
  }
}

export class FakeMailReader implements MailReader {
  readonly queries: MailQuery[] = [];
  constructor(
    public summaries: MailSummary[] = [],
    public message: MailMessage | undefined = undefined,
  ) {}
  async search(query: MailQuery): Promise<MailSummary[]> {
    this.queries.push(query);
    return this.summaries;
  }
  async read(): Promise<MailMessage> {
    if (this.message === undefined) throw new Error('no message');
    return this.message;
  }
}

export class FakeAwaiting implements MailAwaitingReply {
  readonly queries: { olderThanHours: number; newerThanDays: number; limit: number }[] = [];
  constructor(public messages: MailSummary[] = []) {}
  async awaitingReply(query: { olderThanHours: number; newerThanDays: number; limit: number }): Promise<MailSummary[]> {
    this.queries.push(query);
    return this.messages;
  }
}

export class FakePhone implements PhoneSignals {
  constructor(
    public location: PhoneLocation | undefined = undefined,
    public totals: PhoneDayTotals = {},
  ) {}
  async latestLocation(): Promise<PhoneLocation | undefined> {
    return this.location;
  }
  async dayTotals(): Promise<PhoneDayTotals> {
    return this.totals;
  }
  async lastSeen(): Promise<Date | undefined> {
    return this.location?.at;
  }
}

export class FakePlaces implements PlaceSource {
  readonly geocodes: string[] = [];
  constructor(private readonly points: Record<string, GeoPoint> = {}) {}
  async search(): Promise<never[]> {
    return [];
  }
  async geocode(text: string): Promise<GeoPoint | undefined> {
    this.geocodes.push(text);
    return this.points[text];
  }
}

export class FakePeople implements PeopleReader {
  constructor(private readonly people: Record<string, PersonSummary> = {}) {}
  async find(nameOrEmail: string): Promise<PersonSummary | undefined> {
    return this.people[nameOrEmail];
  }
  async openCommitments(): Promise<{ person: string; commitment: PersonSummary['commitments'][number] }[]> {
    return [];
  }
}

export class FakeMemoryWriter implements MemoryWriter {
  readonly remembered: RememberInput[] = [];
  async remember(input: RememberInput): Promise<Fact> {
    this.remembered.push(input);
    return {
      id: `fact-${this.remembered.length}`,
      subject: input.subject,
      text: input.text,
      source: input.source,
      at: NOW.toISOString(),
      strength: 1,
    };
  }
}

export function summary(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    id: 'm1',
    threadId: 't1',
    from: '민수 <minsu@example.com>',
    subject: '견적서 회신',
    snippet: '확인 부탁드려요',
    receivedAt: new Date('2026-11-15T09:00:00+09:00'),
    unread: true,
    important: false,
    ...overrides,
  };
}

export function todo(overrides: Partial<TodoItem> = {}): TodoItem {
  return { id: 'todo-1', text: '할 일', done: false, createdAt: NOW.toISOString(), ...overrides };
}
