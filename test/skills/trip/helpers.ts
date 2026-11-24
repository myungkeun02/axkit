import type {
  GeoPoint,
  MailMessage,
  MailQuery,
  MailReader,
  MailSummary,
  Notice,
  NoticeResult,
  Notifier,
  PlaceSource,
  WeatherReport,
  WeatherSource,
} from '../../../src/core/contracts/index.js';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import type { Confirmer } from '../../../src/core/policy/types.js';
import { tripSkill } from '../../../src/skills/trip/plugin.js';
import type { TripSegment } from '../../../src/skills/trip/types.js';
import type { TestContext } from '../../support/context.js';
import { createTestContext } from '../../support/context.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');

export class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';
  private readonly sent = new Set<string>();

  async notify(notice: Notice): Promise<NoticeResult> {
    if (notice.dedupeKey !== undefined) {
      const key = `${notice.kind}:${notice.dedupeKey}`;
      if (this.sent.has(key)) return 'dropped';
      this.sent.add(key);
    }
    this.notices.push(notice);
    return this.result;
  }
}

export class FakeMail implements MailReader {
  readonly queries: MailQuery[] = [];
  readonly reads: string[] = [];
  failSearch = false;

  constructor(public messages: MailMessage[] = []) {}

  async search(query: MailQuery): Promise<MailSummary[]> {
    this.queries.push(query);
    if (this.failSearch) throw new Error('mail service down');
    return this.messages.slice(0, query.limit).map((message) => ({
      id: message.id,
      threadId: message.threadId,
      from: message.from,
      subject: message.subject,
      snippet: message.snippet,
      receivedAt: message.receivedAt,
      unread: message.unread,
      important: message.important,
    }));
  }

  async read(id: string): Promise<MailMessage> {
    this.reads.push(id);
    const found = this.messages.find((message) => message.id === id);
    if (found === undefined) throw new Error(`no mail ${id}`);
    return found;
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

export class FakeWeather implements WeatherSource {
  readonly asked: GeoPoint[] = [];
  readonly days: string[] = [];
  constructor(public report: WeatherReport | undefined = undefined) {}
  async today(point: GeoPoint): Promise<WeatherReport> {
    this.asked.push(point);
    if (this.report === undefined) throw new Error('weather service down');
    return this.report;
  }
  async forecast(point: GeoPoint, ymd: string): Promise<WeatherReport | undefined> {
    this.days.push(ymd);
    return this.today(point);
  }
}

export interface SetupOptions {
  now?: Date;
  config?: Record<string, unknown>;
  assistant?: Partial<PluginContext['assistant']>;
  llm?: LlmGateway;
  capabilities?: Record<string, unknown>;
  seed?: TripSegment[];
  seen?: string[];
  confirmer?: Confirmer;
}

export async function setupTrip(options: SetupOptions = {}): Promise<TestContext> {
  const context = createTestContext({
    now: options.now ?? NOW,
    ...(options.llm !== undefined ? { llm: options.llm } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.assistant !== undefined ? { assistant: options.assistant } : {}),
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    ...(options.confirmer !== undefined ? { confirmer: options.confirmer } : {}),
  });
  if (options.seed !== undefined) await context.kv.set('segments', options.seed);
  if (options.seen !== undefined) await context.kv.set('seen', options.seen);
  await tripSkill().setup(context.ctx);
  return context;
}

export function mailMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    from: '예약 <booking@example.com>',
    subject: '예약 확인',
    snippet: '예약이 확정되었어요',
    receivedAt: new Date('2026-11-16T09:00:00+09:00'),
    unread: true,
    important: false,
    to: ['owner@example.com'],
    cc: [],
    body: '예약번호 ABC123',
    ...overrides,
  };
}

export function segment(overrides: Partial<TripSegment> = {}): TripSegment {
  return {
    id: 'f1',
    mailId: 'm1',
    kind: 'flight',
    title: 'KE123',
    start: '2026-11-20T08:30:00+09:00',
    startText: '2026-11-20T08:30',
    ...overrides,
  };
}

export async function storedSegments(context: TestContext): Promise<TripSegment[]> {
  return (await context.kv.get<TripSegment[]>('segments')) ?? [];
}

export function doneOutput<T>(outcome: { status: string; output?: unknown }): T {
  if (outcome.status !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
  return outcome.output as T;
}
