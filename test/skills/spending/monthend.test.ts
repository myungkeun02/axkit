import { describe, expect, it } from 'vitest';
import type { ConversationRef, IncomingMessage, OutgoingMessage, Replier } from '../../../src/core/conversation/types.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { TestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { FakeNotifier, setupSpending } from './helpers.js';

const LAST_DAY = new Date('2026-11-30T20:00:00+09:00');

async function setup(
  options: TestContextOptions = {},
): Promise<{ context: TestContext; notifier: FakeNotifier }> {
  const notifier = new FakeNotifier();
  const context = await setupSpending({
    ...options,
    now: options.now ?? LAST_DAY,
    config: { largeAmount: 10_000, ...(options.config ?? {}) },
    capabilities: { [Contracts.notifier.id]: notifier, ...(options.capabilities ?? {}) },
  });
  return { context, notifier };
}

async function add(
  context: TestContext,
  input: { merchant: string; amount: number; date: string; currency?: string },
): Promise<void> {
  const outcome = await context.ctx.tools.execute('spending.add', input);
  if (outcome.status !== 'done') throw new Error(JSON.stringify(outcome));
}

async function seedFlagged(context: TestContext): Promise<void> {
  await add(context, { merchant: '동네가게', amount: 20_000, date: '2026-11-03' });
  for (const month of ['08', '09', '10']) {
    await add(context, { merchant: '스타벅스', amount: 5_000, date: `2026-${month}-10` });
  }
  await add(context, { merchant: '스타벅스', amount: 20_000, date: '2026-11-10' });
  await add(context, { merchant: 'Spotify', amount: 12.34, currency: 'USD', date: '2026-11-12' });
  await add(context, { merchant: '이마트', amount: 50_000, date: '2026-11-05' });
}

function handlerOf(context: TestContext) {
  const handler = context.handlers.find((candidate) => candidate.id === 'spending.monthend');
  if (handler === undefined) throw new Error('month-end handler not registered');
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
    receivedAt: LAST_DAY,
  };
}

describe('spending.monthend job', () => {
  it('sends the last-day card with the total, flags and buttons', async () => {
    const { context, notifier } = await setup();
    await seedFlagged(context);

    await context.scheduler.run('spending.monthend', LAST_DAY);

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice).toMatchObject({ kind: 'spending.monthend', dedupeKey: '2026-11' });
    const text = notice?.text ?? '';
    expect(text).toContain('11월 말일 확인');
    expect(text).toContain('지금까지');
    expect(text).toContain('확인할 것');
    expect(text).toContain('동네가게');
    expect(text).toContain('분류 없음');
    expect(text).toContain('큰 지출');
    expect(text).toContain('환율로 계산함');
    expect(notice?.choices?.map((choice) => [choice.id, choice.label])).toEqual([
      ['spend.me.ok:2026-11', '확인했어요'],
      ['spend.me.more:2026-11', '전체 보기'],
    ]);
  });

  it('sends only on the last local day', async () => {
    const early = new Date('2026-11-29T20:00:00+09:00');
    const { context, notifier } = await setup({ now: early });
    await seedFlagged(context);

    await context.scheduler.run('spending.monthend', early);

    expect(notifier.notices).toEqual([]);
  });

  it('sends only once for the month', async () => {
    const { context, notifier } = await setup();
    await seedFlagged(context);

    await context.scheduler.run('spending.monthend', LAST_DAY);
    await context.scheduler.run('spending.monthend', LAST_DAY);

    expect(notifier.notices).toHaveLength(1);
  });

  it('still sends the total when nothing needs checking', async () => {
    const { context, notifier } = await setup();
    await add(context, { merchant: '이마트', amount: 50_000, date: '2026-11-05' });

    await context.scheduler.run('spending.monthend', LAST_DAY);

    const text = notifier.notices[0]?.text ?? '';
    expect(text).toContain('지금까지 50,000원 썼어요');
    expect(text).toContain('확인할 것이 없어요.');
  });
});

describe('spending.monthend buttons', () => {
  it('marks the month reviewed and acknowledges', async () => {
    const { context } = await setup();
    const { replier, replies } = makeReplier();

    const result = await handlerOf(context).handle(choiceMessage('(choice: spend.me.ok:2026-11)'), replier);

    expect(result).toBe('handled');
    expect(replies[0]?.text).toBe('11월 지출을 확인한 것으로 표시했어요.');
    expect(await context.kv.get('reviewed:2026-11')).toBeTruthy();
  });

  it('replies with every flagged entry and its id', async () => {
    const { context } = await setup();
    await seedFlagged(context);
    const { replier, replies } = makeReplier();

    const result = await handlerOf(context).handle(choiceMessage('(choice: spend.me.more:2026-11)'), replier);

    expect(result).toBe('handled');
    const text = replies[0]?.text ?? '';
    expect(text).toContain('확인할 지출 3건');
    expect(text).toMatch(/- [0-9a-f]{8} · \d\d\/\d\d /);
    expect(text).toContain('동네가게');
    expect(text).toContain('분류를 바꾸거나 지출에서 제외하려면 이 id를 말해 주세요.');
  });

  it('says there is nothing to show when the list is empty', async () => {
    const { context } = await setup();
    await add(context, { merchant: '이마트', amount: 50_000, date: '2026-11-05' });
    const { replier, replies } = makeReplier();

    await handlerOf(context).handle(choiceMessage('(choice: spend.me.more:2026-11)'), replier);

    expect(replies[0]?.text).toBe('확인할 것이 없어요.');
  });

  it('passes messages that are not its own owner choices', async () => {
    const { context } = await setup();
    const { replier } = makeReplier();
    const handler = handlerOf(context);

    expect(await handler.handle(choiceMessage('(choice: spend.me.ok:2026-11)', false), replier)).toBe('pass');
    expect(await handler.handle(choiceMessage('(choice: spend.sub.keep:abcd1234)'), replier)).toBe('pass');
    expect(await handler.handle(choiceMessage('(choice: other:1)'), replier)).toBe('pass');
    expect(await handler.handle(choiceMessage('안녕하세요'), replier)).toBe('pass');
  });
});
