import { describe, expect, it } from 'vitest';
import type { TuningChange } from '../../../src/core/contracts/index.js';
import type { TuningListView } from '../../../src/skills/tuning/tool-list.js';
import type { TuningUndoOutput } from '../../../src/skills/tuning/tool-undo.js';
import type { TestContext } from '../../support/context.js';
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

async function execute(context: TestContext, name: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const outcome = await context.ctx.tools.execute(name, input);
  if (outcome.status !== 'done') throw new Error(`${name}: ${JSON.stringify(outcome)}`);
  return outcome.output;
}

async function withNoticeProposal() {
  const setup = await setupTuning({ now: SUNDAY });
  await emitFeedback(setup.context, [
    feedback('notice', 'chat.replies', 'rejected', { at: new Date(SUNDAY.getTime() - DAY_MS) }),
    feedback('notice', 'chat.replies', 'rejected', { at: new Date(SUNDAY.getTime() - 2 * DAY_MS) }),
  ]);
  await setup.context.scheduler.run('tuning.weekly', SUNDAY);
  const proposal = (await storeOf(setup.context).proposals())[0];
  if (proposal === undefined) throw new Error('no proposal');
  return { ...setup, proposal };
}

async function applyProposal(context: TestContext, id: string): Promise<void> {
  const { replier } = makeReplier();
  await handlerOf(context).handle(choiceMessage(`(choice: tuning.apply:${id})`), replier);
}

describe('tuning.list', () => {
  it('is empty before anything is proposed', async () => {
    const { context } = await setupTuning();

    const view = (await execute(context, 'tuning.list')) as TuningListView;

    expect(view).toMatchObject({ count: 0, open: [], applied: [] });
    expect(view.message).toBe('아직 조정할 것이 없어요.');
  });

  it('shows an open proposal in plain words', async () => {
    const { context } = await withNoticeProposal();

    const view = (await execute(context, 'tuning.list')) as TuningListView;

    expect(view.count).toBe(1);
    expect(view.open[0]?.reason).toBe("알림 'chat.replies' 거절이 2번 있었어요 → 이 알림은 끌까요?");
    expect(view.message).toContain("알림 'chat.replies' 거절이 2번 있었어요");
  });

  it('shows applied changes with their measured effect', async () => {
    const { context, proposal } = await withNoticeProposal();
    await applyProposal(context, proposal.id);
    await context.clock.advance(7 * DAY_MS);
    await context.scheduler.run('tuning.weekly', context.clock.now());

    const view = (await execute(context, 'tuning.list')) as TuningListView;

    expect(view.open).toEqual([]);
    expect(view.applied[0]).toMatchObject({ id: proposal.id, baselinePerWeek: 1, afterPerWeek: 0, undone: false });
  });

  it('works in English', async () => {
    const { context } = await setupTuning({ now: SUNDAY, assistant: { language: 'en' } });
    await emitFeedback(context, [
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(SUNDAY.getTime() - DAY_MS) }),
      feedback('notice', 'chat.replies', 'rejected', { at: new Date(SUNDAY.getTime() - 2 * DAY_MS) }),
    ]);
    await context.scheduler.run('tuning.weekly', SUNDAY);

    const view = (await execute(context, 'tuning.list')) as TuningListView;

    expect(view.open[0]?.reason).toBe(
      "You rejected the 'chat.replies' notice 2 times → turn this notice off?",
    );
  });
});

describe('tuning.undo', () => {
  it('turns a muted notice back on, emits the inverse and marks the record undone', async () => {
    const { context, muter, proposal } = await withNoticeProposal();
    await applyProposal(context, proposal.id);
    expect(muter.kinds.has('chat.replies')).toBe(true);
    const events: TuningChange[] = [];
    context.bus.on('tuning.apply', (change) => {
      events.push(change);
    });

    const result = (await execute(context, 'tuning.undo', { id: proposal.id })) as TuningUndoOutput;

    expect(result.status).toBe('ok');
    expect(result.message).toBe("되돌렸어요 — 알림 'chat.replies' 끄기");
    expect(muter.kinds.has('chat.replies')).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({ domain: 'notice', subject: 'chat.replies', action: 'unmute' }),
    ]);
    expect((await storeOf(context).appliedById(proposal.id))?.undoneAt).toBe(SUNDAY.toISOString());
  });

  it('emits an unmute for a learned spending rule', async () => {
    const { context, muter } = await setupTuning({ now: SUNDAY });
    const change: TuningChange = {
      id: 'cccccccc',
      domain: 'spend.category',
      subject: '커피',
      action: 'set',
      value: 'cafe',
    };
    await storeOf(context).addApplied({
      id: change.id,
      change,
      appliedAt: new Date(SUNDAY.getTime() - DAY_MS).toISOString(),
      baselinePerWeek: 2,
    });
    const events: TuningChange[] = [];
    context.bus.on('tuning.apply', (item) => {
      events.push(item);
    });

    await execute(context, 'tuning.undo', { id: change.id });

    expect(events).toEqual([
      expect.objectContaining({ domain: 'spend.category', subject: '커피', action: 'unmute' }),
    ]);
    expect(muter.kinds.size).toBe(0);
  });

  it('answers not_found for an unknown id and refuses to undo twice', async () => {
    const { context, proposal } = await withNoticeProposal();
    await applyProposal(context, proposal.id);

    const missing = (await execute(context, 'tuning.undo', { id: 'deadbeef' })) as TuningUndoOutput;
    expect(missing.status).toBe('not_found');
    expect(missing.message).toBe('되돌릴 적용 기록을 찾지 못했어요.');

    await execute(context, 'tuning.undo', { id: proposal.id });
    const again = (await execute(context, 'tuning.undo', { id: proposal.id })) as TuningUndoOutput;
    expect(again.status).toBe('already_undone');
    expect(again.message).toBe('이미 되돌린 변경이에요.');
  });

  it('describes the write before running it', async () => {
    const { context } = await setupTuning();

    expect(context.registry.get('tuning.undo')?.describe?.({ id: 'abc12345' })).toBe('조정 되돌리기: #abc12345');
  });
});
