import type { PluginContext } from '../../core/plugin/types.js';
import { monthOf } from '../../core/time/local-day.js';
import type { CandidateReport } from './candidates.js';
import type { ExpensesConfig } from './config.js';
import type { DecisionStore } from './decisions.js';
import type { ExpensesTexts } from './locale.js';
import type { RuleStore } from './rules.js';

interface CachedTotal {
  total: number;
  currency: string;
}

/** Keeps the last month totals so a tool's synchronous describe() can name the amount. */
export class ReportCache {
  private readonly totals = new Map<string, CachedTotal>();

  remember(report: CandidateReport): void {
    this.totals.set(report.month, { total: report.grandTotal, currency: report.currency });
    if (this.totals.size > 24) {
      const oldest = this.totals.keys().next().value;
      if (oldest !== undefined) this.totals.delete(oldest);
    }
  }

  total(month: string): CachedTotal | undefined {
    return this.totals.get(month);
  }
}

export interface ExpenseDeps {
  config: ExpensesConfig;
  texts: ExpensesTexts;
  rules: RuleStore;
  decisions: DecisionStore;
  cache: ReportCache;
}

export function currentMonth(ctx: PluginContext): string {
  return monthOf(ctx.clock.now(), ctx.assistant.timezone);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
