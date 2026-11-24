import type {
  BacklogReader,
  BacklogSnapshot,
  Fact,
  FailureCount,
  FeatureHealth,
  FeatureSwitches,
  HealthCheck,
  HealthFinding,
  HealthRegistry,
  MemoryExpiry,
  NoticeKindStats,
  NoticeStats,
  PauseInput,
  PauseState,
  PurposeUsage,
  UsageReader,
} from '../../../src/core/contracts/index.js';

export const FAKE_NOW = new Date('2026-11-17T09:00:00+09:00');

export class FakeSwitches implements FeatureSwitches {
  readonly states = new Map<string, PauseState>();
  readonly inputs: { feature: string; input: PauseInput }[] = [];
  constructor(private readonly now: () => Date = () => FAKE_NOW) {}

  async pause(feature: string, input: PauseInput): Promise<PauseState> {
    this.inputs.push({ feature, input });
    const state: PauseState = {
      feature,
      reason: input.reason,
      until: input.until.toISOString(),
      byKind: input.by.kind,
      by: input.by.id,
      createdAt: this.now().toISOString(),
      auto: input.by.kind !== 'user',
    };
    this.states.set(feature, state);
    return state;
  }

  async resume(feature: string): Promise<void> {
    this.states.delete(feature);
  }

  async pausedState(feature: string): Promise<PauseState | undefined> {
    const state = this.states.get(feature);
    if (state === undefined) return undefined;
    if (Date.parse(state.until) <= this.now().getTime()) {
      this.states.delete(feature);
      return undefined;
    }
    return state;
  }

  async list(): Promise<PauseState[]> {
    return [...this.states.values()];
  }
}

export class FakeFeatureHealth implements FeatureHealth {
  constructor(public counts: FailureCount[] = []) {}
  async recordFailure(): Promise<'counted' | 'paused'> {
    return 'counted';
  }
  async recordSuccess(): Promise<void> {}
  async failures(): Promise<FailureCount[]> {
    return this.counts;
  }
}

export class FakeBacklog implements BacklogReader {
  constructor(public snapshotValue: BacklogSnapshot) {}
  async snapshot(): Promise<BacklogSnapshot> {
    return this.snapshotValue;
  }
}

export class FakeNoticeStats implements NoticeStats {
  constructor(
    public weekValue: NoticeKindStats[] = [],
    public overBudget = 0,
  ) {}
  async week(): Promise<NoticeKindStats[]> {
    return this.weekValue;
  }
  async overBudgetDays(): Promise<number> {
    return this.overBudget;
  }
}

export class FakeUsage implements UsageReader {
  constructor(public rows: PurposeUsage[] = []) {}
  async byPurpose(): Promise<PurposeUsage[]> {
    return this.rows;
  }
}

export class FakeHealthRegistry implements HealthRegistry {
  readonly checks: HealthCheck[] = [];
  constructor(public findings: HealthFinding[] = []) {}
  register(check: HealthCheck): void {
    this.checks.push(check);
  }
  async runAll(): Promise<HealthFinding[]> {
    return this.findings;
  }
}

export class FakeMemoryExpiry implements MemoryExpiry {
  constructor(public facts: Fact[] = []) {}
  async expired(): Promise<Fact[]> {
    return this.facts;
  }
  async eventHappened(): Promise<Fact[]> {
    return [];
  }
}

export function failure(feature: string, signature: string, count: number): FailureCount {
  return { feature, signature, count };
}

export function noticeKind(kind: string, sent: number, digested = 0): NoticeKindStats {
  return { kind, sent, held: 0, digested, dropped: 0 };
}

export function purpose(purposeName: string, calls: number, failures: number): PurposeUsage {
  return { purpose: purposeName, calls, failures, costUsd: 0, inputTokens: 0, outputTokens: 0 };
}

export function backlogSnapshot(overrides: Partial<BacklogSnapshot> = {}): BacklogSnapshot {
  return {
    open: 5,
    stale: 0,
    createdInWeek: 2,
    doneInWeek: 2,
    autoClosedInWeek: 0,
    openLimit: 6,
    ...overrides,
  };
}
