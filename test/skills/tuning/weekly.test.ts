import { describe, expect, it } from 'vitest';
import type { TuningChange } from '../../../src/core/contracts/index.js';
import { DAY_MS, emitFeedback, feedback, setupTuning, storeOf, SUNDAY } from './helpers.js';

const MONDAY = new Date('2026-11-16T09:00:00+09:00');

describe('tuning weekly job', () => {
  it('sends one notice with a line and two choices per proposal on the configured weekday', async () => {
    const { context, notifier } = await setupTuning({ now: SUNDAY });
    await emitFeedback(context, [
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(SUNDAY.getTime() - 1 * DAY_MS) }),
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(SUNDAY.getTime() - 3 * DAY_MS) }),
    ]);

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice).toMatchObject({ kind: 'tuning.weekly', dedupeKey: 'tuning.weekly:2026-11-15' });
    expect(notice?.text).toContain("알림 'chat.replies' 거절이 2번 있었어요");
    expect(notice?.text).toContain('1.');
    expect(notice?.choices?.map((choice) => choice.label)).toEqual(['적용', '그대로']);
    expect(notice?.choices?.map((choice) => choice.id)).toEqual([
      expect.stringMatching(/^tuning\.apply:[0-9a-f]{8}$/),
      expect.stringMatching(/^tuning\.skip:[0-9a-f]{8}$/),
    ]);

    const proposals = await storeOf(context).proposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: 'open',
      createdAt: SUNDAY.toISOString(),
      change: { domain: 'notice', subject: 'chat.replies', action: 'mute' },
    });
  });

  it('stays quiet on any other day', async () => {
    const { context, notifier } = await setupTuning({ now: MONDAY });
    await emitFeedback(context, [
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(MONDAY.getTime() - DAY_MS) }),
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(MONDAY.getTime() - 2 * DAY_MS) }),
    ]);

    await context.scheduler.run('tuning.weekly', MONDAY);

    expect(notifier.notices).toEqual([]);
  });

  it('checks the weekday in the owner time zone', async () => {
    const sundayInSeoul = new Date('2026-11-15T10:00:00Z');
    const mondayInSeoul = new Date('2026-11-15T16:00:00Z');
    const { context, notifier } = await setupTuning({ now: sundayInSeoul });
    await emitFeedback(context, [
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(sundayInSeoul.getTime() - DAY_MS) }),
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(sundayInSeoul.getTime() - 2 * DAY_MS) }),
    ]);

    await context.scheduler.run('tuning.weekly', mondayInSeoul);
    expect(notifier.notices).toEqual([]);

    await context.scheduler.run('tuning.weekly', sundayInSeoul);
    expect(notifier.notices).toHaveLength(1);
  });

  it('honors a configured weekday', async () => {
    const wednesday = new Date('2026-11-18T19:00:00+09:00');
    const { context, notifier } = await setupTuning({ now: wednesday, config: { weekday: 3 } });
    await emitFeedback(context, [
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(wednesday.getTime() - DAY_MS) }),
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(wednesday.getTime() - 2 * DAY_MS) }),
    ]);

    await context.scheduler.run('tuning.weekly', SUNDAY);
    expect(notifier.notices).toEqual([]);

    await context.scheduler.run('tuning.weekly', wednesday);
    expect(notifier.notices).toHaveLength(1);
  });

  it('explains a learned spending keyword in the notice', async () => {
    const { context, notifier } = await setupTuning({ now: SUNDAY });
    await emitFeedback(context, [
      feedback('spend.category', '별빛커피', 'corrected', {
        at: new Date(SUNDAY.getTime() - DAY_MS),
        correction: 'cafe',
        label: '별빛 커피',
      }),
      feedback('spend.category', '달빛커피', 'corrected', {
        at: new Date(SUNDAY.getTime() - 2 * DAY_MS),
        correction: 'cafe',
        label: '달빛 커피',
      }),
    ]);

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect(notifier.notices[0]?.text).toContain("'커피' 포함 가맹점 2곳을 카페로 고치셨어요");
    expect(notifier.notices[0]?.choices).toHaveLength(2);
  });

  it('sends nothing when there is nothing to suggest or measure', async () => {
    const { context, notifier } = await setupTuning({ now: SUNDAY });

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect(notifier.notices).toEqual([]);
  });
});

describe('measuring applied changes', () => {
  const change: TuningChange = { id: 'aaaaaaaa', domain: 'notice', subject: 'chat.replies', action: 'mute' };

  it('reports the effect after seven days', async () => {
    const { context, notifier } = await setupTuning({ now: SUNDAY });
    const appliedAt = new Date(SUNDAY.getTime() - 10 * DAY_MS);
    const store = storeOf(context);
    await store.addApplied({ id: change.id, change, appliedAt: appliedAt.toISOString(), baselinePerWeek: 3 });
    await emitFeedback(context, [
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(appliedAt.getTime() + 2 * DAY_MS) }),
    ]);

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect(notifier.notices[0]?.text).toContain("알림 'chat.replies' 끄기: 주 3회 → 주 1회");
    expect(notifier.notices[0]?.choices).toBeUndefined();
    const [record] = await store.applied();
    expect(record?.measured?.afterPerWeek).toBe(1);
    expect(record?.measured?.at).toBe(SUNDAY.toISOString());
  });

  it('waits until the change is seven days old', async () => {
    const { context, notifier } = await setupTuning({ now: SUNDAY });
    const appliedAt = new Date(SUNDAY.getTime() - 3 * DAY_MS);
    await storeOf(context).addApplied({
      id: change.id,
      change,
      appliedAt: appliedAt.toISOString(),
      baselinePerWeek: 3,
    });

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect(notifier.notices).toEqual([]);
    const [record] = await storeOf(context).applied();
    expect(record?.measured).toBeUndefined();
  });

  it('counts keyword corrections by label for a learned rule', async () => {
    const { context, notifier } = await setupTuning({ now: SUNDAY });
    const appliedAt = new Date(SUNDAY.getTime() - 8 * DAY_MS);
    const keyword: TuningChange = {
      id: 'bbbbbbbb',
      domain: 'spend.category',
      subject: '커피',
      action: 'set',
      value: 'cafe',
    };
    await storeOf(context).addApplied({
      id: keyword.id,
      change: keyword,
      appliedAt: appliedAt.toISOString(),
      baselinePerWeek: 2,
    });
    await emitFeedback(context, [
      feedback('spend.category', '별빛커피', 'corrected', {
        at: new Date(appliedAt.getTime() + DAY_MS),
        correction: 'food',
        label: '별빛 커피',
      }),
      feedback('spend.category', '달빛국수', 'corrected', {
        at: new Date(appliedAt.getTime() + DAY_MS),
        correction: 'food',
        label: '달빛 국수',
      }),
    ]);

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect(notifier.notices[0]?.text).toContain("'커피' → 카페: 주 2회 → 주 1회");
  });
});
