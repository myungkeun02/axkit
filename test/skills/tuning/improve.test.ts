import { describe, expect, it } from 'vitest';
import type { TuningChange } from '../../../src/core/contracts/index.js';
import { withId } from '../../../src/skills/tuning/change.js';
import { metricOf, metricValue, proposeImprovements } from '../../../src/skills/tuning/improve.js';
import type { WeeklySignals } from '../../../src/skills/tuning/signals.js';
import type { StoredFeedback } from '../../../src/skills/tuning/types.js';
import { backlogSnapshot, failure, noticeKind } from './fakes.js';
import { DAY_MS, NOW } from './helpers.js';

function signals(overrides: Partial<WeeklySignals> = {}): WeeklySignals {
  return {
    cards: [],
    failures: [],
    pauses: [],
    notices: [],
    overBudgetDays: 0,
    models: [],
    expiredFacts: 0,
    findings: [],
    ...overrides,
  };
}

function propose(value: WeeklySignals, extra: { limit?: number; feedback?: StoredFeedback[]; existing?: TuningChange[] } = {}) {
  return proposeImprovements({
    signals: value,
    feedback: extra.feedback ?? [],
    now: NOW,
    existing: extra.existing ?? [],
    limit: extra.limit ?? 5,
  });
}

function accepted(kind: string, at: Date): StoredFeedback {
  return { domain: 'notice', subject: kind, verdict: 'accepted', at: at.toISOString() };
}

describe('feature_failures proposals', () => {
  it('needs ten failures in the week', () => {
    expect(propose(signals({ failures: [failure('mail', 'timeout', 9)] }))).toEqual([]);
    expect(propose(signals({ failures: [failure('mail', 'timeout', 10)] }))).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{8}$/),
        change: expect.objectContaining({ domain: 'feature', subject: 'mail', action: 'mute' }),
        reason: { kind: 'feature_failures', feature: 'mail', perWeek: 10, signature: 'timeout' },
        metric: 'failures:mail',
        baseline: 10,
      },
    ]);
  });

  it('sums signatures and reports the top one', () => {
    const [found] = propose(
      signals({
        failures: [failure('mail', 'timeout', 4), failure('mail', 'timeout', 3), failure('mail', 'http_503', 3)],
      }),
    );
    expect(found?.reason).toEqual({ kind: 'feature_failures', feature: 'mail', perWeek: 10, signature: 'timeout' });
  });

  it('skips a feature that is already paused', () => {
    const pause = {
      feature: 'mail',
      reason: 'x',
      until: new Date(NOW.getTime() + DAY_MS).toISOString(),
      byKind: 'user' as const,
      by: 'owner',
      createdAt: NOW.toISOString(),
      auto: false,
    };
    expect(propose(signals({ failures: [failure('mail', 'timeout', 40)], pauses: [pause] }))).toEqual([]);
  });
});

describe('backlog proposals', () => {
  it('lowers the open limit after three automatic closes', () => {
    const [found] = propose(
      signals({ backlog: backlogSnapshot({ open: 6, openLimit: 6, autoClosedInWeek: 3, createdInWeek: 2, doneInWeek: 2 }) }),
    );
    expect(found?.change).toMatchObject({ domain: 'company.limits', subject: 'maxOpen', action: 'set', value: '4' });
    expect(found?.reason).toEqual({ kind: 'backlog', open: 6, limit: 6, autoClosed: 3, created: 2, done: 2 });
    expect(found?.metric).toBe('backlog.autoclosed');
    expect(found?.baseline).toBe(3);
  });

  it('also reacts when more is created than finished', () => {
    expect(
      propose(signals({ backlog: backlogSnapshot({ createdInWeek: 5, doneInWeek: 2, autoClosedInWeek: 0 }) })),
    ).toHaveLength(1);
    expect(
      propose(signals({ backlog: backlogSnapshot({ createdInWeek: 4, doneInWeek: 0, autoClosedInWeek: 0 }) })),
    ).toHaveLength(0);
    expect(
      propose(signals({ backlog: backlogSnapshot({ createdInWeek: 5, doneInWeek: 3, autoClosedInWeek: 0 }) })),
    ).toHaveLength(0);
  });

  it('never proposes a limit of one or less, and needs the source', () => {
    expect(
      propose(signals({ backlog: backlogSnapshot({ openLimit: 1, autoClosedInWeek: 10 }) })),
    ).toEqual([]);
    expect(propose(signals())).toEqual([]);
  });
});

describe('notice_volume proposals', () => {
  it('needs thirty sent or digested notices', () => {
    expect(propose(signals({ notices: [noticeKind('todo.reminder', 29)] }))).toEqual([]);
    expect(propose(signals({ notices: [noticeKind('todo.reminder', 20, 10)] }))).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{8}$/),
        change: expect.objectContaining({ domain: 'notice', subject: 'todo.reminder', action: 'mute' }),
        reason: { kind: 'notice_volume', noticeKind: 'todo.reminder', perWeek: 30 },
        metric: 'notice:todo.reminder',
        baseline: 30,
      },
    ]);
  });

  it('stays quiet when the owner accepted that notice recently', () => {
    const recent = accepted('todo.reminder', new Date(NOW.getTime() - 3 * DAY_MS));
    const old = accepted('todo.reminder', new Date(NOW.getTime() - 15 * DAY_MS));
    expect(propose(signals({ notices: [noticeKind('todo.reminder', 40)] }), { feedback: [recent] })).toEqual([]);
    expect(propose(signals({ notices: [noticeKind('todo.reminder', 40)] }), { feedback: [old] })).toHaveLength(1);
  });

  it('orders several kinds by volume', () => {
    const found = propose(
      signals({ notices: [noticeKind('small', 30), noticeKind('big', 90), noticeKind('mid', 50)] }),
    );
    expect(found.map((item) => item.change.subject)).toEqual(['big', 'mid', 'small']);
  });
});

describe('proposal selection', () => {
  it('dedupes changes that are already open, applied or declined', () => {
    const existing = [withId({ domain: 'feature', subject: 'mail', action: 'mute' })];
    expect(propose(signals({ failures: [failure('mail', 'timeout', 20)] }), { existing })).toEqual([]);
  });

  it('puts revert proposals first and counts them against the limit', () => {
    const revert = {
      id: 'aaaaaaaa',
      change: withId({ domain: 'feature', subject: 'mail', action: 'unmute' }),
      reason: { kind: 'no_effect' as const, of: 'bbbbbbbb', baseline: 10, after: 10 },
    };
    const found = propose(signals({ failures: [failure('mail', 'timeout', 20)] }), {
      limit: 1,
      existing: [],
    });
    expect(found).toHaveLength(1);

    const withRevert = proposeImprovements({
      signals: signals({ failures: [failure('mail', 'timeout', 20)] }),
      feedback: [],
      now: NOW,
      existing: [],
      limit: 1,
      reverts: [revert],
    });
    expect(withRevert).toEqual([revert]);
  });

  it('never proposes a signal rule without a metric to measure later', () => {
    const found = propose(
      signals({
        failures: [failure('mail', 'timeout', 20)],
        backlog: backlogSnapshot({ autoClosedInWeek: 4 }),
        notices: [noticeKind('todo.reminder', 40)],
      }),
    );
    expect(found).toHaveLength(3);
    expect(found.every((item) => item.metric !== undefined && item.baseline !== undefined)).toBe(true);
  });

  it('respects the configured limit', () => {
    const found = propose(
      signals({
        failures: [failure('mail', 'timeout', 20)],
        backlog: backlogSnapshot({ autoClosedInWeek: 5 }),
        notices: [noticeKind('a', 40), noticeKind('b', 40), noticeKind('c', 40)],
      }),
      { limit: 2 },
    );
    expect(found).toHaveLength(2);
    expect(found[0]?.reason.kind).toBe('feature_failures');
    expect(found[1]?.reason.kind).toBe('backlog');
  });

  it('includes the feedback rules last', () => {
    const rejected: StoredFeedback[] = [
      { domain: 'notice', subject: 'chat.replies', verdict: 'rejected', at: new Date(NOW.getTime() - DAY_MS).toISOString() },
      { domain: 'notice', subject: 'chat.replies', verdict: 'rejected', at: new Date(NOW.getTime() - 2 * DAY_MS).toISOString() },
    ];
    const found = propose(signals({ failures: [failure('mail', 'timeout', 20)] }), { feedback: rejected });
    expect(found.map((item) => item.reason.kind)).toEqual(['feature_failures', 'notice']);
  });
});

describe('metric helpers', () => {
  it('names the metric a change is meant to lower', () => {
    expect(metricOf({ id: 'a', domain: 'notice', subject: 'todo.reminder', action: 'mute' })).toBe(
      'notice:todo.reminder',
    );
    expect(metricOf({ id: 'a', domain: 'feature', subject: 'mail', action: 'unmute' })).toBe('failures:mail');
    expect(metricOf({ id: 'a', domain: 'company.limits', subject: 'maxOpen', action: 'set' })).toBe(
      'backlog.autoclosed',
    );
    expect(metricOf({ id: 'a', domain: 'spend.category', subject: '커피', action: 'set' })).toBeUndefined();
  });

  it('reads the current value, or undefined when the source is missing', () => {
    const value = signals({
      notices: [noticeKind('todo.reminder', 20, 5)],
      failures: [failure('mail', 'timeout', 4), failure('mail', 'http_503', 6)],
      backlog: backlogSnapshot({ autoClosedInWeek: 7 }),
    });
    expect(metricValue('notice:todo.reminder', value)).toBe(25);
    expect(metricValue('notice:missing', value)).toBe(0);
    expect(metricValue('failures:mail', value)).toBe(10);
    expect(metricValue('failures:other', value)).toBe(0);
    expect(metricValue('backlog.autoclosed', value)).toBe(7);
    expect(metricValue('backlog.autoclosed', signals())).toBeUndefined();
    expect(metricValue('unknown', value)).toBeUndefined();
  });
});
