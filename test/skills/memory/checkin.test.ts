import { describe, expect, it } from 'vitest';
import type {
  ConversationRef,
  IncomingMessage,
  OutgoingMessage,
  Replier,
} from '../../../src/core/conversation/types.js';
import type { Fact, FactSourceKind } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Notice, NoticeResult, Notifier } from '../../../src/core/contracts/index.js';
import { memorySkill } from '../../../src/skills/memory/plugin.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const DAY_MS = 86_400_000;

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

function makeReplier(): { replier: Replier; replies: OutgoingMessage[] } {
  const replies: OutgoingMessage[] = [];
  return {
    replies,
    replier: {
      async reply(_conversation: ConversationRef, message: OutgoingMessage) {
        replies.push(message);
      },
    },
  };
}

function choiceMessage(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'test', address: 'owner' },
    authorId: 'owner',
    fromOwner,
    text,
    receivedAt: NOW,
  };
}

async function setup(options: { config?: Record<string, unknown>; confirmer?: FakeConfirmer } = {}) {
  const notifier = new FakeNotifier();
  const context = createTestContext({
    now: NOW,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.confirmer !== undefined ? { confirmer: options.confirmer } : {}),
    capabilities: { [Contracts.notifier.id]: notifier },
  });
  await memorySkill().setup(context.ctx);
  return { context, notifier };
}

async function seed(
  context: Awaited<ReturnType<typeof setup>>['context'],
  text: string,
  options: { source?: FactSourceKind; halfLifeDays?: number; subject?: string } = {},
): Promise<Fact> {
  return context.ctx.use(Contracts.memoryWrite).remember({
    subject: options.subject ?? 'owner',
    text,
    source: { kind: options.source ?? 'chat' },
    halfLifeDays: options.halfLifeDays ?? 90,
  });
}

function handlerOf(context: Awaited<ReturnType<typeof setup>>['context']) {
  const handler = context.handlers.find((candidate) => candidate.id === 'memory.checkin');
  if (handler === undefined) throw new Error('check-in handler not registered');
  return handler;
}

function keepIds(notices: readonly Notice[]): string[] {
  return (notices[0]?.choices ?? [])
    .filter((choice) => choice.id.startsWith('mem.keep:'))
    .map((choice) => choice.id.slice('mem.keep:'.length));
}

describe('memory check-in job', () => {
  it('asks only on the configured weekday', async () => {
    const { context, notifier } = await setup();
    await seed(context, '커피는 아메리카노');
    await context.clock.advance(180 * DAY_MS);

    await context.scheduler.run('memory.checkin', context.clock.now());
    expect(notifier.notices).toHaveLength(1);

    const { context: monday, notifier: mondayNotifier } = await setup({ config: { checkinWeekday: 1 } });
    await seed(monday, '커피는 아메리카노');
    await monday.clock.advance(180 * DAY_MS);
    await monday.scheduler.run('memory.checkin', monday.clock.now());

    expect(mondayNotifier.notices).toHaveLength(0);
  });

  it('lists at most two faded owner facts and records them as asked', async () => {
    const { context, notifier } = await setup();
    const weakest = await seed(context, '커피는 아메리카노를 즐김', { halfLifeDays: 72 });
    const middle = await seed(context, '주말에는 등산을 감', { halfLifeDays: 90 });
    await seed(context, '아침에 집중이 잘 됨', { halfLifeDays: 120 });
    await seed(context, '민수는 등산을 좋아함', { subject: '민수' });
    await seed(context, '메일에서 배송지를 봄', { source: 'mail' });
    await context.clock.advance(180 * DAY_MS);
    await seed(context, '요즘은 차를 마심', { halfLifeDays: 365 });

    await context.scheduler.run('memory.checkin', context.clock.now());

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice).toMatchObject({ kind: 'memory.checkin', dedupeKey: 'memory.checkin:2027-05-16' });
    expect(notice?.text).toContain('아직 맞나요?');
    expect(notice?.text).toContain(weakest.text);
    expect(notice?.text).toContain(middle.text);
    expect(notice?.text).not.toContain('아침에 집중이 잘 됨');
    expect(notice?.choices).toEqual([
      { id: `mem.keep:${weakest.id}`, label: '맞아요' },
      { id: `mem.forget:${weakest.id}`, label: '이제 아니에요' },
      { id: `mem.keep:${middle.id}`, label: '맞아요' },
      { id: `mem.forget:${middle.id}`, label: '이제 아니에요' },
    ]);

    const asked = await context.kv.get<Record<string, string>>('checkin:asked');
    expect(Object.keys(asked ?? {}).sort()).toEqual([weakest.id, middle.id].sort());
    expect(asked?.[weakest.id]).toBe(context.clock.now().toISOString());
  });

  it('skips a fact asked within the last 60 days and retries an older one', async () => {
    const { context, notifier } = await setup();
    const recent = await seed(context, '최근에 물어본 기억');
    const older = await seed(context, '오래전에 물어본 기억');
    const untouched = await seed(context, '아직 묻지 않은 기억');
    await context.clock.advance(180 * DAY_MS);
    const now = context.clock.now();
    await context.kv.set('checkin:asked', {
      [recent.id]: new Date(now.getTime() - 59 * DAY_MS).toISOString(),
      [older.id]: new Date(now.getTime() - 61 * DAY_MS).toISOString(),
    });

    await context.scheduler.run('memory.checkin', now);

    expect(notifier.notices).toHaveLength(1);
    expect(keepIds(notifier.notices)).toEqual([older.id, untouched.id]);
  });

  it('stays quiet when nothing has faded', async () => {
    const { context, notifier } = await setup({ config: { checkinWeekday: 2 } });
    await seed(context, '아직 힘이 센 기억', { halfLifeDays: 365 });

    await context.scheduler.run('memory.checkin', NOW);

    expect(notifier.notices).toHaveLength(0);
  });

  it('can be switched off in config', async () => {
    const { context } = await setup({ config: { checkin: false } });

    expect(context.scheduler.jobs.has('memory.checkin')).toBe(false);
    expect(context.handlers.some((handler) => handler.id === 'memory.checkin')).toBe(false);
  });
});

describe('memory check-in buttons', () => {
  it('confirms a kept fact and brings its strength back to one', async () => {
    const { context } = await setup();
    const fact = await seed(context, '커피는 아메리카노', { halfLifeDays: 90 });
    await context.clock.advance(180 * DAY_MS);
    const { replier, replies } = makeReplier();

    const result = await handlerOf(context).handle(
      choiceMessage(`(choice: mem.keep:${fact.id})`),
      replier,
    );

    expect(result).toBe('handled');
    expect(replies[0]?.text).toBe('기억해 둘게요: 커피는 아메리카노');
    const [recalled] = await context.ctx.use(Contracts.memoryRead).recall({ subject: 'owner', limit: 5 });
    expect(recalled).toMatchObject({ id: fact.id, strength: 1 });
  });

  it('deletes a forgotten fact through the approval card', async () => {
    const confirmer = new FakeConfirmer('approved');
    const { context } = await setup({ confirmer });
    const fact = await seed(context, '이제 아닌 기억');
    const { replier, replies } = makeReplier();

    const result = await handlerOf(context).handle(
      choiceMessage(`(choice: mem.forget:${fact.id})`),
      replier,
    );

    expect(result).toBe('handled');
    expect(confirmer.requests[0]?.effects).toEqual(['delete']);
    expect(replies[0]?.text).toBe('지웠어요: 이제 아닌 기억');
    expect(await context.ctx.use(Contracts.memoryRead).recall({ subject: 'owner', limit: 5 })).toEqual([]);
  });

  it('keeps the fact when the approval is denied', async () => {
    const { context } = await setup({ confirmer: new FakeConfirmer('denied') });
    const fact = await seed(context, '그대로 둘 기억');
    const { replier, replies } = makeReplier();

    await handlerOf(context).handle(choiceMessage(`(choice: mem.forget:${fact.id})`), replier);

    expect(replies[0]?.text).toBe('그대로 두었어요.');
    expect(await context.ctx.use(Contracts.memoryRead).recall({ subject: 'owner', limit: 5 })).toHaveLength(1);
  });

  it('says a missing fact is already gone', async () => {
    const { context } = await setup();
    const { replier, replies } = makeReplier();

    await handlerOf(context).handle(choiceMessage('(choice: mem.keep:missing1)'), replier);

    expect(replies[0]?.text).toBe('이 기억은 이미 없어요.');
  });

  it('passes on other messages, other choices and non-owner messages', async () => {
    const { context } = await setup();
    const { replier } = makeReplier();
    const handler = handlerOf(context);

    expect(await handler.handle(choiceMessage('(choice: other:1)'), replier)).toBe('pass');
    expect(await handler.handle(choiceMessage('안녕하세요'), replier)).toBe('pass');
    expect(await handler.handle(choiceMessage('(choice: mem.keep:abc)', false), replier)).toBe('pass');
  });
});
