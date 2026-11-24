import { z } from 'zod';
import type { CardFeedback, SpendCategory, SpendEntry } from '../../core/contracts/index.js';
import { SPEND_CATEGORIES } from '../../core/contracts/index.js';
import { wallClock } from '../../core/scheduler/next-run.js';
import type { Tool } from '../../core/tools/types.js';
import { monthOf, monthPlus, monthRange, ymdOf } from '../../core/time/local-day.js';
import type { Classifier } from './classify/classifier.js';
import type { LabelStore } from './classify/labels.js';
import type { SpendingConfig } from './config.js';
import type { FxConfig } from './fx.js';
import { roundMoney } from './fx.js';
import type { LedgerStore } from './ledger.js';
import type { SpendingTexts } from './locale.js';

export interface ToolDeps {
  ledger: LedgerStore;
  classifier: Classifier;
  labels: LabelStore;
  config: SpendingConfig;
  fx: FxConfig;
  texts: SpendingTexts;
  now: () => Date;
  timeZone: string;
  /** Publishes an owner correction for self-tuning. */
  emitFeedback(feedback: CardFeedback): Promise<void>;
}

export interface SpendEntryView {
  id: string;
  date: string;
  time: string;
  merchant: string;
  amount: number;
  /** Home currency of `amount`. */
  currency: string;
  /** The charged amount, present only when it differs from the home amount. */
  original?: { amount: number; currency: string };
  category: string;
  card?: string;
  hasReceipt: boolean;
  estimated: boolean;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function toView(entry: SpendEntry, texts: SpendingTexts, homeCurrency: string, timeZone: string): SpendEntryView {
  const at = new Date(entry.at);
  const wall = wallClock(at, timeZone);
  const home = homeCurrency.toUpperCase();
  return {
    id: entry.id,
    date: ymdOf(at, timeZone),
    time: `${pad2(wall.hh)}:${pad2(wall.mm)}`,
    merchant: entry.merchant,
    amount: entry.amount,
    currency: home,
    ...(entry.currency.toUpperCase() !== home
      ? { original: { amount: entry.originalAmount, currency: entry.currency.toUpperCase() } }
      : {}),
    category: texts.category(entry.category),
    ...(entry.card !== undefined ? { card: entry.card } : {}),
    hasReceipt: entry.hasReceipt === true,
    estimated: entry.fxEstimated === true,
  };
}

const listInput = z.object({
  month: z
    .string()
    .regex(MONTH_PATTERN)
    .optional()
    .describe('Month "YYYY-MM"; defaults to the current month in the owner time zone.'),
  category: z.enum(SPEND_CATEGORIES).optional().describe('Only entries in this category.'),
  merchant: z.string().min(1).max(100).optional().describe('Case-insensitive substring of the merchant name.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum entries to return; defaults to 30.'),
});

export type SpendingListInput = z.infer<typeof listInput>;

export function spendingListTool(deps: ToolDeps): Tool<SpendingListInput, SpendEntryView[]> {
  return {
    name: 'spending.list',
    description:
      "List the owner's spending entries for one month, newest first, with the home-currency amount. " +
      'Excluded entries are left out.',
    input: listInput,
    effects: ['read'],
    async run(input) {
      const now = deps.now();
      const month = input.month ?? monthOf(now, deps.timeZone);
      const needle = input.merchant?.toLowerCase();
      const entries = (await deps.ledger.list(monthRange(month, deps.timeZone)))
        .filter((entry) => entry.excluded !== true)
        .filter((entry) => input.category === undefined || entry.category === input.category)
        .filter((entry) => needle === undefined || entry.merchant.toLowerCase().includes(needle))
        .sort((left, right) => right.at.localeCompare(left.at));
      const limit = input.limit ?? 30;
      return entries.slice(0, limit).map((entry) => toView(entry, deps.texts, deps.config.homeCurrency, deps.timeZone));
    },
  };
}

const summaryInput = z.object({
  month: z
    .string()
    .regex(MONTH_PATTERN)
    .optional()
    .describe('Month "YYYY-MM"; defaults to the current month in the owner time zone.'),
});

export type SpendingSummaryInput = z.infer<typeof summaryInput>;

export interface CategoryTotal {
  category: SpendCategory;
  label: string;
  total: number;
  count: number;
}

export interface MerchantTotal {
  merchant: string;
  total: number;
  count: number;
}

export interface SpendingSummary {
  month: string;
  currency: string;
  total: number;
  count: number;
  byCategory: CategoryTotal[];
  topMerchants: MerchantTotal[];
  previousMonth: string;
  previousTotal: number;
  changePercent: number | null;
}

function monthEntries(entries: readonly SpendEntry[]): SpendEntry[] {
  return entries.filter((entry) => entry.excluded !== true);
}

export function spendingSummaryTool(deps: ToolDeps): Tool<SpendingSummaryInput, SpendingSummary> {
  return {
    name: 'spending.summary',
    description:
      'Summarize one month of spending: total, category totals, top merchants and the change from the previous month. ' +
      'Cancellations count as negative amounts.',
    input: summaryInput,
    effects: ['read'],
    async run(input) {
      const now = deps.now();
      const month = input.month ?? monthOf(now, deps.timeZone);
      const previousMonth = monthPlus(month, -1);
      const current = monthEntries(await deps.ledger.list(monthRange(month, deps.timeZone)));
      const previous = monthEntries(await deps.ledger.list(monthRange(previousMonth, deps.timeZone)));
      const home = deps.config.homeCurrency.toUpperCase();

      const categories = new Map<SpendCategory, { total: number; count: number }>();
      const merchants = new Map<string, { total: number; count: number }>();
      let total = 0;
      for (const entry of current) {
        total += entry.amount;
        const category = categories.get(entry.category) ?? { total: 0, count: 0 };
        category.total += entry.amount;
        category.count += 1;
        categories.set(entry.category, category);
        const merchant = merchants.get(entry.merchant) ?? { total: 0, count: 0 };
        merchant.total += entry.amount;
        merchant.count += 1;
        merchants.set(entry.merchant, merchant);
      }
      const previousTotal = previous.reduce((sum, entry) => sum + entry.amount, 0);

      return {
        month,
        currency: home,
        total: roundMoney(home, total),
        count: current.length,
        byCategory: [...categories.entries()]
          .map(([category, value]) => ({
            category,
            label: deps.texts.category(category),
            total: roundMoney(home, value.total),
            count: value.count,
          }))
          .sort((left, right) => right.total - left.total),
        topMerchants: [...merchants.entries()]
          .map(([merchant, value]) => ({
            merchant,
            total: roundMoney(home, value.total),
            count: value.count,
          }))
          .sort((left, right) => right.total - left.total)
          .slice(0, 5),
        previousMonth,
        previousTotal: roundMoney(home, previousTotal),
        changePercent:
          previousTotal === 0
            ? null
            : Math.round(((total - previousTotal) / Math.abs(previousTotal)) * 1000) / 10,
      };
    },
  };
}
