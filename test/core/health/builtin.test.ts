import { describe, expect, it } from 'vitest';
import type { Doc, DocStore } from '../../../src/core/contracts/docs.js';
import type { HealthFinding } from '../../../src/core/contracts/health.js';
import type { NoticeKindStats, NoticeStats } from '../../../src/core/contracts/notify.js';
import type { FeatureSwitches, PauseState } from '../../../src/core/contracts/switches.js';
import type { HealthTexts } from '../../../src/core/health/builtin.js';
import { docChecks, noticeChecks, switchChecks } from '../../../src/core/health/builtin.js';
import { enHealthTexts, koHealthTexts } from '../../../src/core/health/texts.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-17T09:00:00.000Z');

const TEXTS: HealthTexts = {
  switchLongPaused: (feature, days, reason) => `long:${feature}:${days}:${reason}`,
  switchAutoPaused: (feature, reason) => `auto:${feature}:${reason}`,
  switchNone: () => 'none',
  noticeBudget: (days, max) => `budget:${days}:${max}`,
  noticeLoud: (kind, count) => `loud:${kind}:${count}`,
  knowledgeReview: (count) => `review:${count}`,
  knowledgeStale: (count) => `stale:${count}`,
  notGitCheckout: () => 'not-git',
  codeCommitted: () => 'clean',
  uncommittedChanges: (count) => `dirty:${count}`,
  uncommittedFix: () => 'fix',
};

class FakeSwitches implements FeatureSwitches {
  constructor(private readonly states: PauseState[]) {}
  async pause(): Promise<PauseState> {
    throw new Error('unused');
  }
  async resume(): Promise<void> {}
  async pausedState(feature: string): Promise<PauseState | undefined> {
    return this.states.find((state) => state.feature === feature);
  }
  async list(): Promise<PauseState[]> {
    return this.states;
  }
}

function pauseState(feature: string, overrides: Partial<PauseState> = {}): PauseState {
  return {
    feature,
    reason: '정기 점검',
    until: new Date(NOW.getTime() + DAY_MS).toISOString(),
    byKind: 'user',
    by: 'owner',
    createdAt: NOW.toISOString(),
    auto: false,
    ...overrides,
  };
}

function ids(findings: readonly HealthFinding[]): string[] {
  return findings.map((finding) => finding.id);
}

describe('switchChecks', () => {
  it('reports nothing when no pause is on', async () => {
    const check = switchChecks(new FakeSwitches([]), { longDays: 7, texts: TEXTS });
    expect(check.id).toBe('switch.pauses');
    expect(await check.run(NOW)).toEqual([{ id: 'switch.none', area: 'switch', ok: true, line: 'none' }]);
  });

  it('flags a manual pause older than longDays with its age in days', async () => {
    const old = pauseState('skill.mail', { createdAt: new Date(NOW.getTime() - 9 * DAY_MS).toISOString() });
    const fresh = pauseState('skill.calendar', { createdAt: new Date(NOW.getTime() - 7 * DAY_MS).toISOString() });
    const check = switchChecks(new FakeSwitches([old, fresh]), { longDays: 7, texts: TEXTS });

    const findings = await check.run(NOW);
    expect(findings).toEqual([
      { id: 'switch.long:skill.mail', area: 'switch', ok: false, line: 'long:skill.mail:9:정기 점검' },
    ]);
  });

  it('flags automatic pauses regardless of age and never reports both kinds for one pause', async () => {
    const auto = pauseState('connector.gmail', {
      auto: true,
      byKind: 'policy',
      by: 'breaker',
      reason: 'timeout x5',
      createdAt: new Date(NOW.getTime() - 20 * DAY_MS).toISOString(),
    });
    const old = pauseState('skill.mail', { createdAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString() });
    const check = switchChecks(new FakeSwitches([auto, old]), { longDays: 7, texts: TEXTS });

    expect(ids(await check.run(NOW))).toEqual(['switch.auto:connector.gmail', 'switch.long:skill.mail']);
  });
});

class FakeStats implements NoticeStats {
  constructor(
    private readonly weekStats: NoticeKindStats[],
    private readonly over: number,
  ) {}
  async week(): Promise<NoticeKindStats[]> {
    return this.weekStats;
  }
  async overBudgetDays(): Promise<number> {
    return this.over;
  }
}

function kind(kindName: string, sent: number, digested: number): NoticeKindStats {
  return { kind: kindName, sent, held: 0, digested, dropped: 0 };
}

describe('noticeChecks', () => {
  it('passes the budget check while over-budget days stay within the maximum', async () => {
    const check = noticeChecks(new FakeStats([], 2), { texts: TEXTS, maxOverBudgetDays: 2 });
    expect(check.id).toBe('notice.volume');
    expect(await check.run(NOW)).toEqual([{ id: 'notice.budget', area: 'notice', ok: true, line: 'budget:2:2' }]);
  });

  it('fails the budget check over the maximum and reports the three loudest kinds', async () => {
    const stats = new FakeStats(
      [kind('todo.reminder', 30, 30), kind('briefing', 25, 25), kind('watch.price', 20, 20), kind('quiet', 39, 0)],
      3,
    );
    const check = noticeChecks(stats, { texts: TEXTS, maxOverBudgetDays: 2 });

    expect(await check.run(NOW)).toEqual([
      { id: 'notice.budget', area: 'notice', ok: false, line: 'budget:3:2' },
      { id: 'notice.loud:todo.reminder', area: 'notice', ok: false, line: 'loud:todo.reminder:60' },
      { id: 'notice.loud:briefing', area: 'notice', ok: false, line: 'loud:briefing:50' },
      { id: 'notice.loud:watch.price', area: 'notice', ok: false, line: 'loud:watch.price:40' },
    ]);
  });
});

function doc(id: string, overrides: Partial<Doc> = {}): Doc {
  return {
    id,
    kind: 'decision',
    scope: 'company',
    title: id,
    body: '',
    entries: [],
    basedOnFacts: [],
    needsReview: false,
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function fakeDocs(docs: Doc[]): DocStore {
  return {
    get: async (id) => docs.find((entry) => entry.id === id),
    list: async () => docs,
    upsert: async () => {
      throw new Error('unused');
    },
    append: async () => undefined,
    verify: async () => {},
    flagFact: async () => [],
  };
}

describe('docChecks', () => {
  it('passes when no document needs review or has gone stale', async () => {
    const check = docChecks(fakeDocs([doc('a'), doc('b', { lastVerifiedAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString() })]), {
      texts: TEXTS,
      staleDays: 90,
    });
    expect(await check.run(NOW)).toEqual([
      { id: 'knowledge.review', area: 'knowledge', ok: true, line: 'review:0' },
      { id: 'knowledge.stale', area: 'knowledge', ok: true, line: 'stale:0' },
    ]);
  });

  it('counts documents that need review and documents not verified for a long time', async () => {
    const check = docChecks(
      fakeDocs([
        doc('reviewed', { needsReview: true, reviewReason: '사실 만료' }),
        doc('old', { lastVerifiedAt: new Date(NOW.getTime() - 100 * DAY_MS).toISOString() }),
        doc('unknown'),
      ]),
      { texts: TEXTS, staleDays: 90 },
    );

    expect(await check.run(NOW)).toEqual([
      { id: 'knowledge.review', area: 'knowledge', ok: false, line: 'review:1' },
      { id: 'knowledge.stale', area: 'knowledge', ok: false, line: 'stale:1' },
    ]);
  });
});

describe('health texts', () => {
  it('has Korean and English wording for every line', () => {
    expect(koHealthTexts.switchLongPaused('메일', 9, '점검')).toBe('메일 일시정지가 9일째 켜져 있어요: 점검');
    expect(koHealthTexts.noticeBudget(3, 2)).toContain('3일이에요');
    expect(koHealthTexts.knowledgeReview(2)).toBe('다시 확인할 문서가 2개 있어요');
    expect(koHealthTexts.uncommittedChanges(62)).toContain('62개');
    expect(enHealthTexts.switchAutoPaused('mail', 'timeout x5')).toContain('Stopped automatically');
    expect(enHealthTexts.knowledgeStale(2)).toBe('2 documents have not been checked in a long time');
    expect(enHealthTexts.notGitCheckout()).toBe('not a git checkout');
  });
});
