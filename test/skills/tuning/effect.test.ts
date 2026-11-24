import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { TuningChange } from '../../../src/core/contracts/index.js';
import { FakeFeatureHealth, FakeSwitches, failure } from './fakes.js';
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

const FEATURE_CHANGE: TuningChange = { id: 'aaaaaaaa', domain: 'feature', subject: 'mail', action: 'mute' };

function providerCapabilities(health: FakeFeatureHealth, switches: FakeSwitches): Record<string, unknown> {
  return { [Contracts.featureHealth.id]: health, [Contracts.switches.id]: switches };
}

describe('metric measurements', () => {
  it('marks an applied feature pause effective when failures fall, and keeps the numbers', async () => {
    const health = new FakeFeatureHealth([failure('mail', 'timeout', 12)]);
    const switches = new FakeSwitches(() => SUNDAY);
    const { context, notifier } = await setupTuning({
      now: SUNDAY,
      capabilities: providerCapabilities(health, switches),
    });
    await context.scheduler.run('tuning.weekly', SUNDAY);
    const proposal = (await storeOf(context).proposals())[0];
    if (proposal === undefined) throw new Error('no proposal');
    const { replier } = makeReplier();
    await handlerOf(context).handle(choiceMessage(`(choice: tuning.apply:${proposal.id})`), replier);

    const [applied] = await storeOf(context).applied();
    expect(applied).toMatchObject({ metric: 'failures:mail', baseline: 12, baselinePerWeek: 12 });
    expect(applied?.measured).toBeUndefined();
    expect(switches.inputs[0]).toMatchObject({ feature: 'mail' });
    expect(switches.inputs[0]?.input.by).toEqual({ kind: 'user', id: 'owner' });
    expect(switches.inputs[0]?.input.reason).toBe('self-tuning: repeated failures');
    expect(switches.inputs[0]?.input.until).toEqual(new Date(SUNDAY.getTime() + 7 * DAY_MS));

    health.counts = [failure('mail', 'timeout', 3)];
    const later = new Date(SUNDAY.getTime() + 14 * DAY_MS);
    await context.scheduler.run('tuning.weekly', later);

    expect(notifier.notices.at(-1)?.kind).toBe('tuning.weekly');
    expect(notifier.notices.at(-1)?.text).toContain("'mail' 기능 7일 멈추기: 주 12회 → 주 3회");
    const [measured] = await storeOf(context).applied();
    expect(measured?.measured).toEqual({ afterPerWeek: 3, at: later.toISOString(), effective: true });
    expect(await storeOf(context).proposals()).toHaveLength(1);
  });

  it('proposes a revert when the metric does not fall, then undoes the original on apply', async () => {
    const health = new FakeFeatureHealth([failure('mail', 'timeout', 12)]);
    const switches = new FakeSwitches(() => SUNDAY);
    const { context, notifier } = await setupTuning({
      now: SUNDAY,
      capabilities: providerCapabilities(health, switches),
    });
    await context.scheduler.run('tuning.weekly', SUNDAY);
    const original = (await storeOf(context).proposals())[0];
    if (original === undefined) throw new Error('no proposal');
    const { replier } = makeReplier();
    await handlerOf(context).handle(choiceMessage(`(choice: tuning.apply:${original.id})`), replier);

    health.counts = [failure('mail', 'timeout', 15)];
    const later = new Date(SUNDAY.getTime() + 14 * DAY_MS);
    await context.scheduler.run('tuning.weekly', later);

    expect(notifier.notices.at(-1)?.text).toContain("'mail' 기능 7일 멈추기: 주 12회 → 주 15회");
    expect(notifier.notices.at(-1)?.text).toContain("지난주 적용한 'mail' 조정이 효과가 없었어요(주 12 → 15) → 되돌리기");
    const proposals = await storeOf(context).proposals();
    const revert = proposals.find((item) => item.reason.kind === 'no_effect');
    if (revert === undefined) throw new Error('no revert proposal');
    expect(revert.change).toMatchObject({ domain: 'feature', subject: 'mail', action: 'unmute' });

    expect(switches.states.has('mail')).toBe(true);
    await handlerOf(context).handle(choiceMessage(`(choice: tuning.apply:${revert.id})`), replier);

    expect(switches.states.has('mail')).toBe(false);
    const records = await storeOf(context).applied();
    const undone = records.find((item) => item.id === original.id);
    expect(undone?.undoneAt).toBeDefined();
    expect(records.some((item) => item.change.subject === 'mail' && item.change.action === 'unmute')).toBe(true);
  });
});

describe('feedback measurements', () => {
  const change: TuningChange = { id: 'cccccccc', domain: 'notice', subject: 'chat.replies', action: 'mute' };

  it('measures a change without a metric from card feedback', async () => {
    const { context, notifier } = await setupTuning({ now: SUNDAY });
    const appliedAt = new Date(SUNDAY.getTime() - 8 * DAY_MS);
    await storeOf(context).addApplied({ id: change.id, change, appliedAt: appliedAt.toISOString(), baselinePerWeek: 2 });
    await emitFeedback(context, [
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(appliedAt.getTime() + DAY_MS) }),
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(appliedAt.getTime() + 2 * DAY_MS) }),
    ]);

    await context.scheduler.run('tuning.weekly', SUNDAY);

    const [record] = await storeOf(context).applied();
    expect(record?.measured?.effective).toBe(false);
    expect(notifier.notices[0]?.text).toContain("지난주 적용한 'chat.replies' 조정이 효과가 없었어요(주 2 → 2) → 되돌리기");
  });

  it('applying a revert un-mutes the notice and marks the original undone', async () => {
    const { context, muter } = await setupTuning({ now: SUNDAY });
    const appliedAt = new Date(SUNDAY.getTime() - 8 * DAY_MS);
    await storeOf(context).addApplied({ id: change.id, change, appliedAt: appliedAt.toISOString(), baselinePerWeek: 2 });
    await emitFeedback(context, [
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(appliedAt.getTime() + DAY_MS) }),
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(appliedAt.getTime() + 2 * DAY_MS) }),
    ]);
    await context.scheduler.run('tuning.weekly', SUNDAY);
    const revert = (await storeOf(context).proposals()).find((item) => item.reason.kind === 'no_effect');
    if (revert === undefined) throw new Error('no revert proposal');
    const events: TuningChange[] = [];
    context.bus.on('tuning.apply', (item) => {
      events.push(item);
    });
    const { replier, replies } = makeReplier();
    muter.kinds.add('chat.replies');

    await handlerOf(context).handle(choiceMessage(`(choice: tuning.apply:${revert.id})`), replier);

    expect(muter.kinds.has('chat.replies')).toBe(false);
    expect(events.at(-1)).toEqual(revert.change);
    expect(replies.at(-1)?.text).toBe("적용했어요 — 알림 'chat.replies' 다시 켜기");
    const original = await storeOf(context).appliedById(change.id);
    expect(original?.undoneAt).toBeDefined();
    expect((await storeOf(context).proposal(revert.id))?.status).toBe('applied');
  });

  it('skips measurement when the change is already undone', async () => {
    const { context } = await setupTuning({ now: SUNDAY });
    const appliedAt = new Date(SUNDAY.getTime() - 8 * DAY_MS);
    await storeOf(context).addApplied({
      id: FEATURE_CHANGE.id,
      change: FEATURE_CHANGE,
      appliedAt: appliedAt.toISOString(),
      baselinePerWeek: 2,
      undoneAt: new Date(SUNDAY.getTime() - DAY_MS).toISOString(),
    });

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect((await storeOf(context).applied())[0]?.measured).toBeUndefined();
  });
});
