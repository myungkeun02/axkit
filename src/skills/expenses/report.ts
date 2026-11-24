import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { monthRange } from '../../core/time/local-day.js';
import type { CandidateReport } from './candidates.js';
import { evaluateEntries } from './candidates.js';
import { currentMonth, messageOf } from './deps.js';
import type { ExpenseDeps } from './deps.js';

export interface LoadedReport {
  month: string;
  currency: string;
  report: CandidateReport;
}

/** Reads one month from skill.spending and classifies it. Undefined when spending is not connected. */
export async function loadReport(
  ctx: PluginContext,
  deps: ExpenseDeps,
  month?: string,
): Promise<LoadedReport | undefined> {
  const reader = ctx.tryUse(Contracts.spendRead);
  if (reader === undefined) return undefined;
  const ym = month ?? currentMonth(ctx);
  try {
    const entries = await reader.entries(monthRange(ym, ctx.assistant.timezone));
    const currency = reader.homeCurrency();
    const rules = await deps.rules.all();
    const report = await evaluateEntries({
      entries,
      rules,
      decisions: deps.decisions,
      timeZone: ctx.assistant.timezone,
      month: ym,
      currency,
    });
    deps.cache.remember(report);
    return { month: ym, currency, report };
  } catch (error) {
    ctx.log.warn('expenses: month could not be loaded', { error: messageOf(error) });
    return undefined;
  }
}
