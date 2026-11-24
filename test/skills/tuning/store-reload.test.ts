import { describe, expect, it } from 'vitest';
import type { Proposal, ProposalReason } from '../../../src/skills/tuning/types.js';
import { TuningStore } from '../../../src/skills/tuning/store.js';
import { NOW, setupTuning } from './helpers.js';

const REASONS: ProposalReason[] = [
  { kind: 'notice_volume', noticeKind: 'todo.reminder', perWeek: 31 },
  { kind: 'feature_failures', feature: 'mail', perWeek: 12, signature: 'timeout' },
  { kind: 'backlog', open: 8, limit: 6, autoClosed: 4, created: 7, done: 2 },
  { kind: 'no_effect', of: 'aaaaaaaa', baseline: 12, after: 15 },
];

function proposalOf(index: number, reason: ProposalReason): Proposal {
  return {
    id: `p${index}`,
    change: { id: `c${index}`, domain: 'notice', subject: `kind${index}`, action: 'mute' },
    reason,
    createdAt: NOW.toISOString(),
    status: 'open',
    metric: `notice:kind${index}`,
    baseline: 30,
  };
}

describe('TuningStore reload', () => {
  it('keeps every new reason kind across a reload', async () => {
    const { context } = await setupTuning();
    const first = new TuningStore(context.kv, () => NOW);
    await first.addProposals(REASONS.map((reason, index) => proposalOf(index, reason)));

    const reloaded = new TuningStore(context.kv, () => NOW);
    const proposals = await reloaded.proposals();

    expect(proposals).toHaveLength(REASONS.length);
    expect(proposals.map((item) => item.reason)).toEqual(REASONS);
    expect(proposals[0]?.metric).toBe('notice:kind0');
    expect(proposals[0]?.baseline).toBe(30);
  });

  it('keeps metric, baseline and effectiveness on applied records across a reload', async () => {
    const { context } = await setupTuning();
    const first = new TuningStore(context.kv, () => NOW);
    await first.addApplied({
      id: 'a1',
      change: { id: 'c1', domain: 'feature', subject: 'mail', action: 'mute' },
      appliedAt: NOW.toISOString(),
      baselinePerWeek: 12,
      metric: 'failures:mail',
      baseline: 12,
    });
    await first.markMeasured('a1', { afterPerWeek: 3, at: NOW.toISOString(), effective: true });

    const reloaded = new TuningStore(context.kv, () => NOW);
    const [record] = await reloaded.applied();

    expect(record).toMatchObject({
      metric: 'failures:mail',
      baseline: 12,
      baselinePerWeek: 12,
      measured: { afterPerWeek: 3, effective: true },
    });
  });

  it('drops a record whose new reason shape is malformed', async () => {
    const { context } = await setupTuning();
    await context.kv.set('proposals', [
      { ...proposalOf(0, REASONS[1] as ProposalReason), reason: { kind: 'feature_failures', feature: 'mail' } },
    ]);

    const store = new TuningStore(context.kv, () => NOW);

    expect(await store.proposals()).toEqual([]);
  });
});
