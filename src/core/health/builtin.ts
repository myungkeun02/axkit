import type { DocStore } from '../contracts/docs.js';
import type { HealthCheck, HealthFinding } from '../contracts/health.js';
import type { NoticeStats } from '../contracts/notify.js';
import type { FeatureSwitches } from '../contracts/switches.js';

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const LOUD_THRESHOLD = 40;
const LOUD_TOP = 3;

/** Every owner-facing line a builtin health check can produce. */
export interface HealthTexts {
  switchLongPaused(feature: string, days: number, reason: string): string;
  switchAutoPaused(feature: string, reason: string): string;
  switchNone(): string;
  noticeBudget(days: number, maxOverBudgetDays: number): string;
  noticeLoud(kind: string, count: number): string;
  knowledgeReview(count: number): string;
  knowledgeStale(count: number): string;
  notGitCheckout(): string;
  codeCommitted(): string;
  uncommittedChanges(count: number): string;
  uncommittedFix(): string;
}

function finding(id: string, area: HealthFinding['area'], ok: boolean, line: string): HealthFinding {
  return { id, area, ok, line };
}

/** Pauses that have stayed on longer than `longDays`, plus any pause the breaker set. */
export function switchChecks(
  switches: FeatureSwitches,
  opts: { longDays: number; texts: HealthTexts },
): HealthCheck {
  return {
    id: 'switch.pauses',
    async run(now: Date): Promise<readonly HealthFinding[]> {
      const findings: HealthFinding[] = [];
      const longMs = opts.longDays * DAY_MS;
      for (const state of await switches.list()) {
        if (state.auto) {
          findings.push(
            finding(
              `switch.auto:${state.feature}`,
              'switch',
              false,
              opts.texts.switchAutoPaused(state.feature, state.reason),
            ),
          );
          continue;
        }
        const age = now.getTime() - new Date(state.createdAt).getTime();
        if (age <= longMs) continue;
        const days = Math.floor(age / DAY_MS);
        findings.push(
          finding(
            `switch.long:${state.feature}`,
            'switch',
            false,
            opts.texts.switchLongPaused(state.feature, days, state.reason),
          ),
        );
      }
      if (findings.length === 0) findings.push(finding('switch.none', 'switch', true, opts.texts.switchNone()));
      return findings;
    },
  };
}

/** The weekly notice budget and the three noisiest notice kinds. */
export function noticeChecks(
  stats: NoticeStats,
  opts: { texts: HealthTexts; maxOverBudgetDays: number },
): HealthCheck {
  return {
    id: 'notice.volume',
    async run(now: Date): Promise<readonly HealthFinding[]> {
      const over = await stats.overBudgetDays(now, WEEK_DAYS);
      const findings: HealthFinding[] = [
        finding(
          'notice.budget',
          'notice',
          over <= opts.maxOverBudgetDays,
          opts.texts.noticeBudget(over, opts.maxOverBudgetDays),
        ),
      ];
      const loud = (await stats.week(now))
        .map((entry) => ({ kind: entry.kind, count: entry.sent + entry.digested }))
        .filter((entry) => entry.count >= LOUD_THRESHOLD)
        .sort((a, b) => b.count - a.count)
        .slice(0, LOUD_TOP);
      for (const entry of loud) {
        findings.push(finding(`notice.loud:${entry.kind}`, 'notice', false, opts.texts.noticeLoud(entry.kind, entry.count)));
      }
      return findings;
    },
  };
}

/** Documents the owner should look at again, and documents nobody has confirmed for a long time. */
export function docChecks(docs: DocStore, opts: { texts: HealthTexts; staleDays: number }): HealthCheck {
  return {
    id: 'knowledge.docs',
    async run(now: Date): Promise<readonly HealthFinding[]> {
      const all = await docs.list();
      const review = all.filter((doc) => doc.needsReview).length;
      const staleMs = opts.staleDays * DAY_MS;
      const stale = all.filter(
        (doc) =>
          doc.lastVerifiedAt !== undefined &&
          now.getTime() - new Date(doc.lastVerifiedAt).getTime() > staleMs,
      ).length;
      return [
        finding('knowledge.review', 'knowledge', review === 0, opts.texts.knowledgeReview(review)),
        finding('knowledge.stale', 'knowledge', stale === 0, opts.texts.knowledgeStale(stale)),
      ];
    },
  };
}
