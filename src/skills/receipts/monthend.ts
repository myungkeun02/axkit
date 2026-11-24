import type { SpendEntry } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { lastDayOfMonth, monthOf, monthPlus, monthRange, ymdOf } from '../../core/time/local-day.js';
import type { ReceiptsConfig } from './config.js';
import { missingMinimum } from './config.js';
import type { ReceiptsTexts } from './locale.js';
import { missingReceipts } from './missing.js';
import { loadMonth } from './store.js';
import type { DocKind } from './types.js';
import { DOC_KINDS } from './types.js';

export const MONTH_END_JOB = 'receipts.monthend';
const SENT_PREFIX = 'monthEndSent:';

export interface MonthEndDeps {
  config: ReceiptsConfig;
  texts: ReceiptsTexts;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

async function missingOf(
  ctx: PluginContext,
  config: ReceiptsConfig,
  ym: string,
  timeZone: string,
): Promise<SpendEntry[]> {
  const spend = ctx.tryUse(Contracts.spendRead);
  if (spend === undefined) return [];
  try {
    const home = spend.homeCurrency();
    const entries = await spend.entries(monthRange(ym, timeZone));
    const months = [-1, 0, 1].map((offset) => monthPlus(ym, offset));
    const docs = (await Promise.all(months.map((month) => loadMonth(ctx.kv, month)))).flat();
    return missingReceipts(entries, docs, missingMinimum(config, home));
  } catch (error) {
    ctx.log.warn('receipts: spending data unavailable for the month-end summary', { error: errorName(error) });
    return [];
  }
}

/** Month-end text, or undefined when there is nothing to report. */
export async function buildMonthEndText(
  ctx: PluginContext,
  deps: MonthEndDeps,
  ym: string,
): Promise<string | undefined> {
  const { config, texts } = deps;
  const timeZone = ctx.assistant.timezone;
  const entries = await loadMonth(ctx.kv, ym);
  const missing = await missingOf(ctx, config, ym, timeZone);
  if (entries.length === 0 && missing.length === 0) return undefined;

  const lines = [texts.monthEndTitle(ym)];
  const counts = new Map<DocKind, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  for (const kind of DOC_KINDS) {
    const count = counts.get(kind);
    if (count !== undefined && count > 0) lines.push(texts.kindCount(kind, count));
  }

  const sums = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== 'receipt' || entry.amount === undefined || entry.currency === undefined) continue;
    sums.set(entry.currency, (sums.get(entry.currency) ?? 0) + entry.amount);
  }
  for (const currency of [...sums.keys()].sort()) {
    lines.push(texts.receiptSum(sums.get(currency) ?? 0, currency));
  }

  if (missing.length > 0) {
    lines.push(texts.missingTitle);
    for (const entry of missing) {
      const mmdd = ymdOf(new Date(entry.at), timeZone).slice(5).replace('-', '/');
      lines.push(`- ${texts.missingLine(mmdd, entry.merchant, texts.formatMoney(entry.amount, entry.currency))}`);
    }
    lines.push(texts.missingNote);
  }
  return lines.join('\n');
}

/** Registers the daily check that only acts on the last local day of the month, once per month. */
export function registerMonthEnd(ctx: PluginContext, deps: MonthEndDeps): void {
  ctx.scheduler.add({
    name: MONTH_END_JOB,
    schedule: { kind: 'daily', at: deps.config.monthEndAt as `${number}:${number}` },
    async run(now) {
      const timeZone = ctx.assistant.timezone;
      const ym = monthOf(now, timeZone);
      if (ymdOf(now, timeZone) !== lastDayOfMonth(ym)) return;

      const sentKey = `${SENT_PREFIX}${ym}`;
      if ((await ctx.kv.get<boolean>(sentKey)) === true) return;

      const text = await buildMonthEndText(ctx, deps, ym);
      if (text === undefined) return;

      const notifier = ctx.tryUse(Contracts.notifier);
      if (notifier === undefined) {
        ctx.log.warn('receipts: no notifier available; month-end summary skipped');
        return;
      }
      await notifier.notify({ kind: 'receipts.monthend', dedupeKey: ym, text });
      await ctx.kv.set(sentKey, true);
    },
  });
}
