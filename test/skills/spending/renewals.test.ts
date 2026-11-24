import { describe, expect, it } from 'vitest';
import type { ConversationRef, IncomingMessage, OutgoingMessage, Replier } from '../../../src/core/conversation/types.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { TestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { FakeNotifier, setupSpending } from './helpers.js';

const N_DAYS_BEFORE = new Date('2026-04-12T09:30:00+09:00');

async function setup(
  options: TestContextOptions = {},
): Promise<{ context: TestContext; notifier: FakeNotifier }> {
  const notifier = new FakeNotifier();
  const context = await setupSpending({
    ...options,
    now: options.now ?? N_DAYS_BEFORE,
    capabilities: { [Contracts.notifier.id]: notifier, ...(options.capabilities ?? {}) },
  });
  return { context, notifier };
}

async function add(
  context: TestContext,
  merchant: string,
  amount: number,
  date: string,
): Promise<void> {
  const outcome = await context.ctx.tools.execute('spending.add', { merchant, amount, date });
  if (outcome.status !== 'done') throw new Error(JSON.stringify(outcome));
}

async function seedNetflix(context: TestContext, amounts = [10_000, 10_000, 10_000]): Promise<void> {
  const dates = ['2026-01-15', '2026-02-15', '2026-03-15'];
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const amount = amounts[index];
    if (date === undefined || amount === undefined) continue;
    await add(context, '넷플릭스', amount, date);
  }
}

function handlerOf(context: TestContext) {
  const handler = context.handlers.find((candidate) => candidate.id === 'spending.subscriptions');
  if (handler === undefined) throw new Error('subscription handler not registered');
  return handler;
}

function makeReplier(): { replier: Replier; replies: OutgoingMessage[] } {
  const replies: OutgoingMessage[] = [];
  const replier: Replier = {
    async reply(_conversation: ConversationRef, message: OutgoingMessage) {
      replies.push(message);
    },
  };
  return { replier, replies };
}

function choiceMessage(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'test', address: 'owner' },
    authorId: 'owner',
    fromOwner,
    text,
    receivedAt: N_DAYS_BEFORE,
  };
}

describe('spending.subscriptions renewal job', () => {
  it('notices exactly renewalNoticeDays before the next charge', async () => {
    const { context, notifier } = await setup();
    await seedNetflix(context);

    await context.scheduler.run('spending.subscriptions', N_DAYS_BEFORE);

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice).toMatchObject({ kind: 'spending.renewal', dedupeKey: '넷플릭스:monthly:2026-04-15' });
    expect(notice?.text).toBe('04/15 갱신 예정: 넷플릭스 10,000원 (매월)');
    expect(notice?.choices?.map((choice) => choice.label)).toEqual(['계속 쓸게요', '해지 방법']);
    expect(notice?.choices?.map((choice) => choice.id)).toEqual([
      expect.stringMatching(/^spend\.sub\.keep:[0-9a-f]{8}$/),
      expect.stringMatching(/^spend\.sub\.cancel:[0-9a-f]{8}$/),
    ]);
  });

  it('stays quiet on any other day', async () => {
    const twoDays = new Date('2026-04-13T09:30:00+09:00');
    const { context, notifier } = await setup({ now: twoDays });
    await seedNetflix(context);

    await context.scheduler.run('spending.subscriptions', twoDays);

    expect(notifier.notices).toEqual([]);
  });

  it('honors a configured renewalNoticeDays', async () => {
    const { context, notifier } = await setup({ config: { renewalNoticeDays: 2 } });
    await seedNetflix(context);

    await context.scheduler.run('spending.subscriptions', N_DAYS_BEFORE);

    expect(notifier.notices).toEqual([]);
  });

  it('announces a price rise only once', async () => {
    const first = new Date('2026-04-01T09:30:00+09:00');
    const { context, notifier } = await setup({ now: first });
    await seedNetflix(context, [10_000, 10_000, 13_000]);

    await context.scheduler.run('spending.subscriptions', first);
    await context.scheduler.run('spending.subscriptions', first);

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]).toMatchObject({ kind: 'spending.price_up' });
    expect(notifier.notices[0]?.text).toBe('넷플릭스 가격이 올랐어요: 10,000원 → 13,000원');
  });
});

describe('spending.subscriptions buttons', () => {
  it('mutes the reminder until the next cycle when the owner keeps it', async () => {
    const { context, notifier } = await setup();
    await seedNetflix(context);
    await context.scheduler.run('spending.subscriptions', N_DAYS_BEFORE);
    const keepId = notifier.notices[0]?.choices?.[0]?.id;
    if (keepId === undefined) throw new Error('no keep choice');
    const { replier, replies } = makeReplier();

    const result = await handlerOf(context).handle(choiceMessage(`(choice: ${keepId})`), replier);

    expect(result).toBe('handled');
    expect(replies[0]?.text).toBe('넷플릭스 갱신 알림은 다음 주기까지 보내지 않을게요.');
    await context.scheduler.run('spending.subscriptions', N_DAYS_BEFORE);
    expect(notifier.notices).toHaveLength(1);
  });

  it('gives cancellation guidance and never runs a tool', async () => {
    const { context, notifier } = await setup();
    await seedNetflix(context);
    await context.scheduler.run('spending.subscriptions', N_DAYS_BEFORE);
    const cancelId = notifier.notices[0]?.choices?.[1]?.id;
    if (cancelId === undefined) throw new Error('no cancel choice');
    const { replier, replies } = makeReplier();

    const result = await handlerOf(context).handle(choiceMessage(`(choice: ${cancelId})`), replier);

    expect(result).toBe('handled');
    expect(replies[0]?.text).toContain('넷플릭스 해지는 https://www.netflix.com/account에서 할 수 있어요.');
    expect(replies[0]?.text).toContain('해지는 직접 해 주셔야 해요. 제가 대신 해지하지 않아요.');
    expect(notifier.notices).toHaveLength(1);
    expect((context.confirmer as { requests: unknown[] }).requests).toHaveLength(0);
  });

  it('uses generic guidance for a merchant without a known page', async () => {
    const { context, notifier } = await setup();
    await add(context, '동네 구독', 10_000, '2026-01-15');
    await add(context, '동네 구독', 10_000, '2026-02-15');
    await add(context, '동네 구독', 10_000, '2026-03-15');
    await context.scheduler.run('spending.subscriptions', N_DAYS_BEFORE);
    const cancelId = notifier.notices[0]?.choices?.[1]?.id;
    if (cancelId === undefined) throw new Error('no cancel choice');
    const { replier, replies } = makeReplier();

    await handlerOf(context).handle(choiceMessage(`(choice: ${cancelId})`), replier);

    expect(replies[0]?.text).toContain('동네 구독 해지는 카드사 앱의 정기결제 관리나 서비스 설정에서 할 수 있어요.');
    expect(replies[0]?.text).toContain('제가 대신 해지하지 않아요.');
  });

  it('passes foreign or unknown buttons', async () => {
    const { context } = await setup();
    const { replier } = makeReplier();
    const handler = handlerOf(context);

    expect(await handler.handle(choiceMessage('(choice: spend.sub.keep:abcd1234)', false), replier)).toBe('pass');
    expect(await handler.handle(choiceMessage('(choice: spend.me.ok:2026-04)'), replier)).toBe('pass');
    expect(await handler.handle(choiceMessage('(choice: other:1)'), replier)).toBe('pass');
    expect(await handler.handle(choiceMessage('안녕하세요'), replier)).toBe('pass');
  });
});

describe('spending.subscriptions off', () => {
  it('registers neither the job, the tool nor the handler', async () => {
    const { context } = await setup({ config: { subscriptions: false } });

    expect(context.scheduler.jobs.has('spending.subscriptions')).toBe(false);
    expect(context.registry.get('subscriptions.list')).toBeUndefined();
    expect(context.handlers.some((handler) => handler.id === 'spending.subscriptions')).toBe(false);
  });
});
