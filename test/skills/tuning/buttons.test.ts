import { describe, expect, it } from 'vitest';
import type { TuningChange } from '../../../src/core/contracts/index.js';
import {
  choiceMessage,
  DAY_MS,
  emitFeedback,
  feedback,
  handlerOf,
  makeReplier,
  setupTuning,
  storeOf,
  SUNDAY,
} from './helpers.js';

async function seedNoticeProposal(): Promise<Awaited<ReturnType<typeof setupTuning>>> {
  const setup = await setupTuning({ now: SUNDAY });
  await emitFeedback(setup.context, [
    feedback('notice', 'chat.replies', 'rejected', { at: new Date(SUNDAY.getTime() - DAY_MS) }),
    feedback('notice', 'chat.replies', 'rejected', { at: new Date(SUNDAY.getTime() - 3 * DAY_MS) }),
  ]);
  await setup.context.scheduler.run('tuning.weekly', SUNDAY);
  return setup;
}

function recordBus(context: Awaited<ReturnType<typeof setupTuning>>['context']): TuningChange[] {
  const events: TuningChange[] = [];
  context.bus.on('tuning.apply', (change) => {
    events.push(change);
  });
  return events;
}

describe('tuning buttons', () => {
  it('applies a notice change: mutes the kind, emits tuning.apply and records the baseline', async () => {
    const { context, muter } = await seedNoticeProposal();
    const proposal = (await storeOf(context).proposals())[0];
    if (proposal === undefined) throw new Error('no proposal');
    const events = recordBus(context);
    const { replier, replies } = makeReplier();

    const result = await handlerOf(context).handle(
      choiceMessage(`(choice: tuning.apply:${proposal.id})`),
      replier,
    );

    expect(result).toBe('handled');
    expect(muter.kinds.has('chat.replies')).toBe(true);
    expect(events).toEqual([proposal.change]);
    expect(replies.map((reply) => reply.text)).toEqual(["적용했어요 — 알림 'chat.replies' 끄기"]);

    const [applied] = await storeOf(context).applied();
    expect(applied).toMatchObject({
      id: proposal.id,
      change: proposal.change,
      appliedAt: SUNDAY.toISOString(),
      baselinePerWeek: 1,
    });
    expect((await storeOf(context).proposal(proposal.id))?.status).toBe('applied');
  });

  it('declines without touching anything', async () => {
    const { context, muter } = await seedNoticeProposal();
    const proposal = (await storeOf(context).proposals())[0];
    if (proposal === undefined) throw new Error('no proposal');
    const events = recordBus(context);
    const { replier, replies } = makeReplier();

    const result = await handlerOf(context).handle(
      choiceMessage(`(choice: tuning.skip:${proposal.id})`),
      replier,
    );

    expect(result).toBe('handled');
    expect(muter.kinds.size).toBe(0);
    expect(events).toEqual([]);
    expect(replies.map((reply) => reply.text)).toEqual(["그대로 둘게요 — 알림 'chat.replies' 끄기"]);
    expect((await storeOf(context).proposal(proposal.id))?.status).toBe('declined');
    expect(await storeOf(context).applied()).toEqual([]);
  });

  it('passes for anyone but the owner and for other messages', async () => {
    const { context } = await seedNoticeProposal();
    const proposal = (await storeOf(context).proposals())[0];
    if (proposal === undefined) throw new Error('no proposal');
    const { replier, replies } = makeReplier();
    const handler = handlerOf(context);

    expect(await handler.handle(choiceMessage(`(choice: tuning.apply:${proposal.id})`, false), replier)).toBe('pass');
    expect(await handler.handle(choiceMessage('안녕'), replier)).toBe('pass');
    expect(replies).toEqual([]);
  });

  it('answers politely for an unknown or already handled id', async () => {
    const { context } = await seedNoticeProposal();
    const proposal = (await storeOf(context).proposals())[0];
    if (proposal === undefined) throw new Error('no proposal');
    const { replier, replies } = makeReplier();
    const handler = handlerOf(context);

    expect(await handler.handle(choiceMessage('(choice: tuning.apply:deadbeef)'), replier)).toBe('handled');
    expect(replies[0]?.text).toBe('이 제안은 이미 처리됐거나 찾을 수 없어요.');

    await handler.handle(choiceMessage(`(choice: tuning.apply:${proposal.id})`), replier);
    await handler.handle(choiceMessage(`(choice: tuning.apply:${proposal.id})`), replier);
    expect(replies.at(-1)?.text).toBe('이 제안은 이미 처리됐거나 찾을 수 없어요.');
  });

  it('applies a chat.appointment change without touching notice mutes', async () => {
    const { context, muter } = await setupTuning({ now: SUNDAY });
    await emitFeedback(context, [
      feedback('chat.appointment', '민수', 'rejected', { at: new Date(SUNDAY.getTime() - DAY_MS) }),
      feedback('chat.appointment', '민수', 'rejected', { at: new Date(SUNDAY.getTime() - 2 * DAY_MS) }),
      feedback('chat.appointment', '민수', 'rejected', { at: new Date(SUNDAY.getTime() - 3 * DAY_MS) }),
    ]);
    await context.scheduler.run('tuning.weekly', SUNDAY);
    const proposal = (await storeOf(context).proposals())[0];
    if (proposal === undefined) throw new Error('no proposal');
    const events = recordBus(context);
    const { replier } = makeReplier();

    await handlerOf(context).handle(choiceMessage(`(choice: tuning.apply:${proposal.id})`), replier);

    expect(events).toEqual([proposal.change]);
    expect(muter.kinds.size).toBe(0);
    expect((await storeOf(context).applied())[0]?.baselinePerWeek).toBe(1.5);
  });
});
