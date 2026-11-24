import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { FailureCount, FeatureHealth, Fact } from '../../../src/core/contracts/index.js';
import { collectSignals } from '../../../src/skills/tuning/signals.js';
import {
  backlogSnapshot,
  failure,
  FakeBacklog,
  FakeFeatureHealth,
  FakeHealthRegistry,
  FakeMemoryExpiry,
  FakeNoticeStats,
  FakeSwitches,
  FakeUsage,
  noticeKind,
  purpose,
} from './fakes.js';
import { DAY_MS, feedback, NOW, setupTuning, storeOf } from './helpers.js';

const FACT: Fact = {
  id: 'f1',
  subject: 'owner',
  text: 'moving in December',
  source: { kind: 'chat' },
  at: NOW.toISOString(),
  strength: 0.5,
  expired: true,
};

describe('collectSignals', () => {
  it('reads every available source', async () => {
    const { context } = await setupTuning({
      capabilities: {
        [Contracts.featureHealth.id]: new FakeFeatureHealth([failure('mail', 'timeout', 4)]),
        [Contracts.switches.id]: new FakeSwitches(),
        [Contracts.backlog.id]: new FakeBacklog(backlogSnapshot({ open: 8, autoClosedInWeek: 2 })),
        [Contracts.noticeStats.id]: new FakeNoticeStats([noticeKind('todo.reminder', 12, 5)], 3),
        [Contracts.usage.id]: new FakeUsage([purpose('company.lead', 20, 5)]),
        [Contracts.memoryExpiry.id]: new FakeMemoryExpiry([FACT]),
        [Contracts.health.id]: new FakeHealthRegistry([
          { id: 'switch.long-paused:mail', area: 'switch', ok: false, line: 'mail is paused' },
          { id: 'backlog.stale', area: 'backlog', ok: true, line: 'fine' },
        ]),
      },
    });
    const store = storeOf(context);
    await store.append(feedback('notice', 'todo.reminder', 'rejected', { at: NOW }));
    await store.append(feedback('notice', 'todo.reminder', 'accepted', { at: NOW }));
    await store.append(feedback('spend.category', '별빛커피', 'corrected', { at: NOW }));

    const signals = await collectSignals(context.ctx, store, NOW);

    expect(signals.cards).toEqual([
      { domain: 'notice', accepted: 1, rejected: 1, corrected: 0 },
      { domain: 'spend.category', accepted: 0, rejected: 0, corrected: 1 },
    ]);
    expect(signals.failures).toEqual([failure('mail', 'timeout', 4)]);
    expect(signals.pauses).toEqual([]);
    expect(signals.backlog).toMatchObject({ open: 8, autoClosedInWeek: 2 });
    expect(signals.notices).toEqual([noticeKind('todo.reminder', 12, 5)]);
    expect(signals.overBudgetDays).toBe(3);
    expect(signals.models).toEqual([purpose('company.lead', 20, 5)]);
    expect(signals.expiredFacts).toBe(1);
    expect(signals.findings).toEqual([
      { id: 'switch.long-paused:mail', area: 'switch', ok: false, line: 'mail is paused' },
    ]);
  });

  it('yields empty values when no optional capability exists', async () => {
    const { context } = await setupTuning();

    const signals = await collectSignals(context.ctx, storeOf(context), NOW);

    expect(signals).toEqual({
      cards: [],
      failures: [],
      pauses: [],
      notices: [],
      overBudgetDays: 0,
      models: [],
      expiredFacts: 0,
      findings: [],
    });
    expect(signals.backlog).toBeUndefined();
  });

  it('keeps the other sources when one throws', async () => {
    class BrokenHealth implements FeatureHealth {
      async recordFailure(): Promise<'counted'> {
        return 'counted';
      }
      async recordSuccess(): Promise<void> {}
      async failures(): Promise<FailureCount[]> {
        throw new Error('store unavailable');
      }
    }
    const { context } = await setupTuning({
      capabilities: {
        [Contracts.featureHealth.id]: new BrokenHealth(),
        [Contracts.noticeStats.id]: new FakeNoticeStats([noticeKind('todo.reminder', 40)], 1),
      },
    });

    const signals = await collectSignals(context.ctx, storeOf(context), NOW);

    expect(signals.failures).toEqual([]);
    expect(signals.notices).toEqual([noticeKind('todo.reminder', 40)]);
    expect(signals.overBudgetDays).toBe(1);
  });

  it('only counts feedback from the last seven days', async () => {
    const { context } = await setupTuning();
    const store = storeOf(context);
    await store.append(feedback('notice', 'old', 'rejected', { at: new Date(NOW.getTime() - 10 * DAY_MS) }));
    await store.append(feedback('notice', 'new', 'rejected', { at: new Date(NOW.getTime() - 6 * DAY_MS) }));

    const signals = await collectSignals(context.ctx, store, NOW);

    expect(signals.cards).toEqual([{ domain: 'notice', accepted: 0, rejected: 1, corrected: 0 }]);
  });
});
