import { Contracts } from '../../core/contracts/index.js';
import type {
  BacklogSnapshot,
  FailureCount,
  HealthFinding,
  NoticeKindStats,
  PauseState,
  PurposeUsage,
} from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { TuningStore } from './store.js';
import type { StoredFeedback } from './types.js';

export interface DomainCards {
  domain: string;
  accepted: number;
  rejected: number;
  corrected: number;
}

/** Everything the weekly loop may act on; each source is optional at run time. */
export interface WeeklySignals {
  cards: DomainCards[];
  failures: FailureCount[];
  pauses: PauseState[];
  backlog?: BacklogSnapshot;
  notices: NoticeKindStats[];
  overBudgetDays: number;
  models: PurposeUsage[];
  expiredFacts: number;
  findings: HealthFinding[];
}

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

/** One broken source must not hide the rest of the week's signals. */
async function guard<T>(ctx: PluginContext, source: string, empty: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    ctx.log.warn('tuning: signal source failed', { source });
    return empty;
  }
}

function groupCards(feedback: readonly StoredFeedback[]): DomainCards[] {
  const groups = new Map<string, DomainCards>();
  for (const item of feedback) {
    const counts = groups.get(item.domain) ?? { domain: item.domain, accepted: 0, rejected: 0, corrected: 0 };
    counts[item.verdict] += 1;
    groups.set(item.domain, counts);
  }
  return [...groups.values()].sort((left, right) => left.domain.localeCompare(right.domain));
}

/** Reads every available signal for the last week; missing capabilities yield their empty value. */
export async function collectSignals(
  ctx: PluginContext,
  store: TuningStore,
  now: Date,
): Promise<WeeklySignals> {
  const since = new Date(now.getTime() - WEEK_DAYS * DAY_MS);

  const cards = await guard(ctx, 'feedback', [], async () => groupCards(await store.since(since)));

  const featureHealth = ctx.tryUse(Contracts.featureHealth);
  const failures =
    featureHealth === undefined
      ? []
      : await guard(ctx, 'featureHealth', [], () => featureHealth.failures(since));

  const switches = ctx.tryUse(Contracts.switches);
  const pauses = switches === undefined ? [] : await guard(ctx, 'switches', [], () => switches.list());

  const backlogReader = ctx.tryUse(Contracts.backlog);
  const backlog =
    backlogReader === undefined
      ? undefined
      : await guard<BacklogSnapshot | undefined>(ctx, 'backlog', undefined, () => backlogReader.snapshot(now));

  const noticeStats = ctx.tryUse(Contracts.noticeStats);
  const notices =
    noticeStats === undefined ? [] : await guard(ctx, 'noticeStats.week', [], () => noticeStats.week(now));
  const overBudgetDays =
    noticeStats === undefined
      ? 0
      : await guard(ctx, 'noticeStats.overBudget', 0, () => noticeStats.overBudgetDays(now, WEEK_DAYS));

  const usage = ctx.tryUse(Contracts.usage);
  const models = usage === undefined ? [] : await guard(ctx, 'usage', [], () => usage.byPurpose(since));

  const expiry = ctx.tryUse(Contracts.memoryExpiry);
  const expiredFacts =
    expiry === undefined ? 0 : await guard(ctx, 'memoryExpiry', 0, async () => (await expiry.expired()).length);

  const health = ctx.tryUse(Contracts.health);
  const findings =
    health === undefined
      ? []
      : await guard(ctx, 'health', [], async () => (await health.runAll(now)).filter((item) => !item.ok));

  return {
    cards,
    failures,
    pauses,
    ...(backlog !== undefined ? { backlog } : {}),
    notices,
    overBudgetDays,
    models,
    expiredFacts,
    findings,
  };
}
