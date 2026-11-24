import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { monthPlus, ymdOf } from '../../core/time/local-day.js';
import type { SpendingConfig } from './config.js';
import { shortDateOf } from './format.js';
import type { LedgerStore } from './ledger.js';
import { loadPatternMonth } from './load-patterns.js';
import type { SpendingTexts } from './locale.js';
import type { BandPattern, MonthPatterns } from './patterns.js';

export const REPORT_JOB = 'spending.report';
const LAST_REPORT_KEY = 'report:last';
const MAX_NOTABLE = 3;
const MAX_UNUSUAL = 3;
const MAX_TOP = 3;

export interface ReportDeps {
  config: SpendingConfig;
  ledger: LedgerStore;
  texts: SpendingTexts;
  timeZone: string;
}

function topBand(bands: readonly BandPattern[]): BandPattern | undefined {
  return bands.reduce<BandPattern | undefined>(
    (best, band) => (best === undefined || band.total > best.total ? band : best),
    undefined,
  );
}

function categoryChangeLine(patterns: MonthPatterns, texts: SpendingTexts): string[] {
  return patterns.changes.map((change) =>
    texts.reportCategoryChange(
      texts.category(change.category),
      texts.money(Math.abs(change.change), patterns.currency),
      change.direction,
    ),
  );
}

function notableLines(patterns: MonthPatterns, texts: SpendingTexts): string[] {
  const changes = categoryChangeLine(patterns, texts);
  const lines: string[] = [];
  const first = changes[0];
  if (first !== undefined) lines.push(first);
  if (patterns.total !== 0) lines.push(texts.reportWeekendShare(patterns.weekend.share));
  const busiest = topBand(patterns.bands);
  if (busiest !== undefined && busiest.total !== 0) lines.push(texts.reportBandShare(busiest.band, busiest.share));
  for (let index = 1; index < changes.length && lines.length < MAX_NOTABLE; index += 1) {
    const line = changes[index];
    if (line !== undefined) lines.push(line);
  }
  return lines.slice(0, MAX_NOTABLE);
}

/** Deterministic month report: totals, top lines, up to three pattern lines and up to three large charges. */
export function buildReportText(patterns: MonthPatterns, texts: SpendingTexts, timeZone: string): string {
  const lines = [
    texts.reportTitle(texts.monthLabel(patterns.month)),
    texts.reportTotal(texts.money(patterns.total, patterns.currency), patterns.totalChangePercent),
  ];
  const categories = patterns.byCategory
    .filter((category) => category.total > 0)
    .slice(0, MAX_TOP)
    .map((category) => `${texts.category(category.category)} ${texts.money(category.total, patterns.currency)}`);
  if (categories.length > 0) lines.push(texts.reportTopCategories(categories.join(' · ')));
  const merchants = patterns.topMerchants
    .filter((merchant) => merchant.total > 0)
    .slice(0, MAX_TOP)
    .map((merchant) => `${merchant.merchant} ${texts.money(merchant.total, patterns.currency)}`);
  if (merchants.length > 0) lines.push(texts.reportTopMerchants(merchants.join(' · ')));
  lines.push(...notableLines(patterns, texts));
  for (const unusual of patterns.unusual.slice(0, MAX_UNUSUAL)) {
    lines.push(
      texts.reportUnusual(
        shortDateOf(new Date(unusual.entry.at), timeZone),
        unusual.entry.merchant,
        texts.money(unusual.entry.amount, patterns.currency),
      ),
    );
  }
  if (patterns.fxEstimatedCount > 0) lines.push(texts.reportFxCount(patterns.fxEstimatedCount));
  return lines.join('\n');
}

async function runReport(ctx: PluginContext, deps: ReportDeps, now: Date): Promise<void> {
  const today = ymdOf(now, deps.timeZone);
  if (today.slice(8, 10) !== '01') return;
  const month = monthPlus(today.slice(0, 7), -1);
  if ((await ctx.kv.get<string>(LAST_REPORT_KEY)) === month) return;

  const loaded = await loadPatternMonth(
    deps.ledger,
    month,
    deps.timeZone,
    deps.config.homeCurrency,
    deps.config.largeAmount,
  );
  if (loaded.entries.length === 0) return;

  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('spending report: no notifier available');
    return;
  }
  await notifier.notify({
    kind: REPORT_JOB,
    dedupeKey: month,
    text: buildReportText(loaded.patterns, deps.texts, deps.timeZone),
  });
  await ctx.kv.set(LAST_REPORT_KEY, month);
}

/** Registers the daily job; it only speaks on the first local day of a month. */
export function registerReport(ctx: PluginContext, deps: ReportDeps): void {
  ctx.scheduler.add({
    name: REPORT_JOB,
    schedule: { kind: 'daily', at: deps.config.reportAt as `${number}:${number}` },
    run: (now) => runReport(ctx, deps, now),
  });
}
