import { describe, expect, it } from 'vitest';
import type {
  CalendarEvent,
  CalendarReader,
  MailMessage,
  MailQuery,
  MailReader,
  MailSummary,
  TimeRange,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { memorySkill } from '../../../src/skills/memory/plugin.js';
import { createTestContext, ScriptedLlm } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

class FakeMail implements MailReader {
  readonly readIds: string[] = [];

  constructor(private readonly messages: MailMessage[]) {}

  async search(query: MailQuery): Promise<MailSummary[]> {
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
    this.readIds.push(id);
    const found = this.messages.find((message) => message.id === id);
    if (found === undefined) throw new Error(`No mail ${id}`);
    return found;
  }
}

class FakeCalendar implements CalendarReader {
  readonly ranges: TimeRange[] = [];

  constructor(private readonly events: CalendarEvent[]) {}

  async listEvents(range: TimeRange): Promise<CalendarEvent[]> {
    this.ranges.push(range);
    return this.events;
  }
}

function mail(overrides: Partial<MailMessage> & { id: string }): MailMessage {
  return {
    threadId: `thread-${overrides.id}`,
    from: '민수 <minsu@example.com>',
    subject: '자료 요청',
    snippet: '',
    receivedAt: NOW,
    unread: true,
    important: false,
    to: ['owner@example.com'],
    cc: [],
    body: '안녕하세요. 다음 주 월요일까지 자료 보내 주세요. 감사합니다.',
    ...overrides,
  };
}

const EXTRACTED = JSON.stringify({
  summary: '다음 주 월요일까지 자료를 보내 달라고 함',
  commitments: [
    {
      direction: 'theirs',
      kind: 'request',
      text: '다음 주 월요일까지 자료 보내기',
      due: '2026-11-23',
      quote: '다음 주 월요일까지 자료 보내 주세요',
    },
    { direction: 'mine', kind: 'promise', text: '자료 검토하기', quote: '이 문장은 본문에 없어요' },
  ],
});

async function setup(opts: { mail?: FakeMail; calendar?: CalendarReader; llm?: ScriptedLlm } = {}) {
  const llm = opts.llm ?? new ScriptedLlm();
  const capabilities: Record<string, unknown> = {};
  if (opts.mail !== undefined) capabilities[Contracts.mailRead.id] = opts.mail;
  if (opts.calendar !== undefined) capabilities[Contracts.calendarRead.id] = opts.calendar;
  const context = createTestContext({ now: NOW, llm, capabilities });
  await memorySkill().setup(context.ctx);
  return { context, llm };
}

describe('mail scan job', () => {
  it('records an interaction and only commitments whose quote is in the body', async () => {
    const fakeMail = new FakeMail([
      mail({ id: 'm1' }),
      mail({
        id: 'auto',
        from: 'no-reply@example.com',
        subject: '알림',
        body: '자동 발송 메일입니다.',
      }),
    ]);
    const { context, llm } = await setup({ mail: fakeMail, llm: new ScriptedLlm([EXTRACTED]) });

    await context.scheduler.run('memory.people.mail', NOW);

    expect(llm.requests[0]).toMatchObject({
      purpose: 'memory.mail',
      tier: 'fast',
      sensitivity: 'sensitive',
    });
    expect(llm.requests[0]?.messages[0]?.content).toContain('data');
    const person = await context.ctx.use(Contracts.peopleRead).find('minsu@example.com');
    expect(person?.interactions).toMatchObject([
      { channel: 'mail', summary: '다음 주 월요일까지 자료를 보내 달라고 함', ref: 'm1' },
    ]);
    expect(person?.commitments).toHaveLength(1);
    expect(person?.commitments[0]).toMatchObject({
      direction: 'theirs',
      kind: 'request',
      text: '다음 주 월요일까지 자료 보내기',
      due: '2026-11-23',
    });
    expect(fakeMail.readIds).toEqual(['m1']);
  });

  it('does not process the same mail twice', async () => {
    const fakeMail = new FakeMail([mail({ id: 'm1' })]);
    const { context, llm } = await setup({ mail: fakeMail, llm: new ScriptedLlm([EXTRACTED]) });

    await context.scheduler.run('memory.people.mail', NOW);
    await context.scheduler.run('memory.people.mail', NOW);

    expect(llm.requests).toHaveLength(1);
    expect(fakeMail.readIds).toEqual(['m1']);
  });

  it('retries a mail whose extraction failed', async () => {
    const fakeMail = new FakeMail([mail({ id: 'm1' })]);
    const { context, llm } = await setup({ mail: fakeMail, llm: new ScriptedLlm(['not json', EXTRACTED]) });

    await context.scheduler.run('memory.people.mail', NOW);
    expect(await context.ctx.use(Contracts.peopleRead).find('민수')).toBeUndefined();

    await context.scheduler.run('memory.people.mail', NOW);
    expect(llm.requests).toHaveLength(2);
    expect((await context.ctx.use(Contracts.peopleRead).find('민수'))?.interactions).toHaveLength(1);
  });

  it('does nothing when no mail connector is available', async () => {
    const { context, llm } = await setup();

    await context.scheduler.run('memory.people.mail', NOW);

    expect(llm.requests).toEqual([]);
  });
});

describe('calendar sweep job', () => {
  it("records meetings with today's attendees in the owner's zone", async () => {
    const calendar = new FakeCalendar([
      {
        id: 'e1',
        title: '주간 회의',
        start: '2026-11-17T15:00:00+09:00',
        end: '2026-11-17T16:00:00+09:00',
        allDay: false,
        attendees: ['지은 <jieun@example.com>'],
      },
    ]);
    const { context } = await setup({ calendar });

    await context.scheduler.run('memory.people.calendar', NOW);

    expect(calendar.ranges[0]?.from.toISOString()).toBe('2026-11-16T15:00:00.000Z');
    expect(calendar.ranges[0]?.to.toISOString()).toBe('2026-11-17T15:00:00.000Z');
    const person = await context.ctx.use(Contracts.peopleRead).find('지은');
    expect(person?.interactions).toMatchObject([
      { channel: 'calendar', summary: '만남: 주간 회의', ref: 'e1' },
    ]);
  });

  it('leaves the day alone when the calendar call fails', async () => {
    const failing: CalendarReader = {
      async listEvents() {
        throw new Error('offline');
      },
    };
    const { context } = await setup({ calendar: failing });

    await context.scheduler.run('memory.people.calendar', NOW);

    expect(await context.ctx.use(Contracts.peopleRead).openCommitments()).toEqual([]);
  });
});
