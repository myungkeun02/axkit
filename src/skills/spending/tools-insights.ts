import { z } from 'zod';
import { monthOf, ymdOf } from '../../core/time/local-day.js';
import type { Tool } from '../../core/tools/types.js';
import type { SpendingConfig } from './config.js';
import { loadDetected } from './detect.js';
import { roundMoney } from './fx.js';
import type { LedgerStore } from './ledger.js';
import { loadPatternMonth } from './load-patterns.js';
import type { MonthPatterns } from './patterns.js';
import type { Cadence } from './subscriptions.js';

export interface InsightToolDeps {
  ledger: LedgerStore;
  config: SpendingConfig;
  now: () => Date;
  timeZone: string;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const patternsInput = z.object({
  month: z
    .string()
    .regex(MONTH_PATTERN)
    .optional()
    .describe('Month "YYYY-MM"; defaults to the current month in the owner time zone.'),
});

export type SpendingPatternsInput = z.infer<typeof patternsInput>;

export function spendingPatternsTool(
  deps: InsightToolDeps,
): Tool<SpendingPatternsInput, MonthPatterns> {
  return {
    name: 'spending.patterns',
    description:
      'Analyze one month of spending: totals by category, top merchants, weekday/weekend and time-of-day shares, ' +
      'notable category changes, unusually large charges and possible duplicates. Excluded entries are left out.',
    input: patternsInput,
    effects: ['read'],
    async run(input) {
      const month = input.month ?? monthOf(deps.now(), deps.timeZone);
      const loaded = await loadPatternMonth(
        deps.ledger,
        month,
        deps.timeZone,
        deps.config.homeCurrency,
        deps.config.largeAmount,
      );
      return loaded.patterns;
    },
  };
}

export interface SubscriptionView {
  key: string;
  merchant: string;
  cadence: Cadence;
  amount: number;
  currency: string;
  charges: number;
  nextDate: string;
  lapsed: boolean;
}

export interface SubscriptionsView {
  currency: string;
  monthlyEquivalentTotal: number;
  subscriptions: SubscriptionView[];
}

const subscriptionsInput = z.object({});

export type SubscriptionsListInput = z.infer<typeof subscriptionsInput>;

export function subscriptionsListTool(
  deps: InsightToolDeps,
): Tool<SubscriptionsListInput, SubscriptionsView> {
  return {
    name: 'subscriptions.list',
    description:
      'List recurring payments detected in the read-only ledger, with the next renewal date in the owner time zone ' +
      'and the monthly-equivalent total.',
    input: subscriptionsInput,
    effects: ['read'],
    async run() {
      const now = deps.now();
      const currency = deps.config.homeCurrency.toUpperCase();
      const detected = await loadDetected(
        { ledger: deps.ledger, timeZone: deps.timeZone, homeCurrency: deps.config.homeCurrency },
        now,
      );
      let monthly = 0;
      for (const sub of detected) monthly += sub.cadence === 'monthly' ? sub.amount : sub.amount / 12;
      return {
        currency,
        monthlyEquivalentTotal: roundMoney(currency, monthly),
        subscriptions: detected.map((sub) => ({
          key: sub.key,
          merchant: sub.merchant,
          cadence: sub.cadence,
          amount: roundMoney(currency, sub.amount),
          currency: sub.currency,
          charges: sub.charges,
          nextDate: ymdOf(sub.nextAt, deps.timeZone),
          lapsed: sub.lapsed,
        })),
      };
    },
  };
}
