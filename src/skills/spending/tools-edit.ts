import { z } from 'zod';
import type { SpendCategory, SpendEntry } from '../../core/contracts/index.js';
import { SPEND_CATEGORIES } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import { zonedIso } from '../../core/time/date-spec.js';
import { monthOf, monthPlus, monthRange } from '../../core/time/local-day.js';
import { toHome } from './fx.js';
import { cleanMerchant, merchantKey } from './normalize.js';
import type { SpendEntryView, ToolDeps } from './tools.js';
import { toView } from './tools.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

const addInput = z.object({
  merchant: z.string().min(1).max(80).describe('Merchant or place name as the owner said it.'),
  amount: z.number().positive().max(1_000_000_000_000).describe('Amount in major units, without a currency sign.'),
  currency: z.string().regex(CURRENCY_PATTERN).optional().describe('ISO 4217 code; defaults to the home currency.'),
  date: z.string().regex(DATE_PATTERN).describe('Local calendar date "YYYY-MM-DD".'),
  time: z.string().regex(TIME_PATTERN).optional().describe('Local time "HH:MM"; defaults to 00:00.'),
  category: z.enum(SPEND_CATEGORIES).optional().describe('Category when the owner named one.'),
});

export type SpendingAddInput = z.infer<typeof addInput>;

const setCategoryInput = z
  .object({
    entryId: z.string().min(1).optional().describe('Id from spending.list.'),
    merchant: z.string().min(1).max(80).optional().describe('Merchant name; applies to its entries this and last month.'),
    category: z.enum(SPEND_CATEGORIES).describe('The category the owner chose.'),
    remember: z.boolean().default(true).describe('Also label this merchant for future entries.'),
  })
  .refine((value) => value.entryId !== undefined || value.merchant !== undefined, {
    message: 'entryId or merchant is required',
  });

export type SpendingSetCategoryInput = z.infer<typeof setCategoryInput>;

const excludeInput = z.object({
  entryId: z.string().min(1).describe('Id from spending.list.'),
  excluded: z.boolean().default(true).describe('True hides it from totals; false restores it.'),
});

export type SpendingExcludeInput = z.infer<typeof excludeInput>;

function localInstant(date: string, time: string | undefined, timeZone: string): Date {
  try {
    return new Date(zonedIso(date, time ?? '00:00', timeZone));
  } catch {
    throw new Error(`Invalid local date or time: ${date} ${time ?? ''}`.trim());
  }
}

function categoryLabel(deps: ToolDeps, category: SpendCategory | undefined): string | undefined {
  return category === undefined ? undefined : deps.texts.category(category);
}

export function spendingAddTool(deps: ToolDeps): Tool<SpendingAddInput, SpendEntryView> {
  return {
    name: 'spending.add',
    description:
      "Add a spend the owner states by hand. Amounts are in major units; pass the currency only when it is not " +
      'the home currency. This never pays anything.',
    input: addInput,
    effects: ['write'],
    describe(input) {
      const currency = (input.currency ?? deps.config.homeCurrency).toUpperCase();
      return deps.texts.addDescription(input.merchant, input.amount, currency, categoryLabel(deps, input.category));
    },
    async run(input) {
      const merchant = cleanMerchant(input.merchant);
      if (merchant === '') throw new Error('merchant is empty after removing card-like digits');
      const currency = (input.currency ?? deps.config.homeCurrency).toUpperCase();
      const home = toHome(input.amount, currency, deps.fx);
      const classification =
        input.category !== undefined
          ? { category: input.category, categorySource: 'owner' as const }
          : await deps.classifier.classify(merchant);
      const result = await deps.ledger.add({
        at: localInstant(input.date, input.time, deps.timeZone),
        merchant,
        merchantKey: merchantKey(merchant),
        amount: home.amount,
        currency,
        originalAmount: input.amount,
        fxEstimated: home.estimated,
        source: 'manual',
        category: classification.category,
        categorySource: classification.categorySource,
      });
      return toView(result.entry, deps.texts, deps.config.homeCurrency, deps.timeZone);
    },
  };
}

function matchesMerchant(entry: SpendEntry, key: string): boolean {
  return entry.merchantKey === key || (key.length >= 3 && entry.merchantKey.includes(key));
}

function rangeMonths(deps: ToolDeps): string[] {
  const current = monthOf(deps.now(), deps.timeZone);
  return [current, monthPlus(current, -1)];
}

async function entriesFor(deps: ToolDeps, key: string): Promise<SpendEntry[]> {
  const found: SpendEntry[] = [];
  for (const month of rangeMonths(deps)) {
    for (const entry of await deps.ledger.list(monthRange(month, deps.timeZone))) {
      if (matchesMerchant(entry, key)) found.push(entry);
    }
  }
  return found;
}

export function spendingSetCategoryTool(
  deps: ToolDeps,
): Tool<SpendingSetCategoryInput, { updated: number; entries: SpendEntryView[] }> {
  return {
    name: 'spending.set_category',
    description:
      "Change the category of one spend (entryId) or of a merchant's entries this and last month. With remember, " +
      'the merchant is labeled so future entries use the same category.',
    input: setCategoryInput,
    effects: ['write'],
    describe(input) {
      const merchant =
        input.merchant ?? deps.ledger.peek(input.entryId ?? '')?.merchant ?? input.entryId ?? deps.texts.noMerchant;
      return deps.texts.setCategoryDescription(merchant, deps.texts.category(input.category));
    },
    async run(input) {
      let key: string;
      let merchant: string;
      let changed = false;
      const ids = new Set<string>();
      if (input.entryId !== undefined) {
        const entry = await deps.ledger.get(input.entryId);
        if (entry === undefined) throw new Error(`No spending entry ${input.entryId}`);
        key = entry.merchantKey;
        merchant = entry.merchant;
        ids.add(entry.id);
        if (entry.category !== input.category) changed = true;
      } else {
        merchant = input.merchant ?? '';
        key = merchantKey(merchant);
        for (const entry of await entriesFor(deps, key)) {
          if (entry.category !== input.category) changed = true;
          ids.add(entry.id);
        }
      }

      for (const id of ids) await deps.ledger.update(id, { category: input.category, categorySource: 'owner' });

      if (input.remember) {
        await deps.labels.setOwner(key, input.category);
        for (const entry of await entriesFor(deps, key)) {
          if (entry.category === input.category && entry.categorySource === 'owner') continue;
          ids.add(entry.id);
          if (entry.category !== input.category) changed = true;
          await deps.ledger.update(entry.id, { category: input.category, categorySource: 'owner' });
        }
      }

      if (changed) {
        await deps.emitFeedback({
          domain: 'spend.category',
          subject: key,
          verdict: 'corrected',
          correction: input.category,
          label: merchant,
          at: deps.now(),
        });
      }

      const entries: SpendEntryView[] = [];
      for (const id of ids) {
        const entry = await deps.ledger.get(id);
        if (entry !== undefined) entries.push(toView(entry, deps.texts, deps.config.homeCurrency, deps.timeZone));
      }
      return { updated: ids.size, entries };
    },
  };
}

export interface ExcludedResult {
  id: string;
  merchant: string;
  excluded: boolean;
}

export function spendingExcludeTool(deps: ToolDeps): Tool<SpendingExcludeInput, ExcludedResult> {
  return {
    name: 'spending.exclude',
    description:
      'Hide one spend from lists and totals when it is not really spending (a transfer, a test charge), or restore it.',
    input: excludeInput,
    effects: ['write'],
    describe(input) {
      const entry = deps.ledger.peek(input.entryId);
      const merchant = entry?.merchant ?? input.entryId;
      const amount = entry === undefined ? undefined : deps.texts.money(entry.amount, deps.config.homeCurrency);
      return deps.texts.excludeDescription(merchant, amount, input.excluded);
    },
    async run(input) {
      const updated = await deps.ledger.update(input.entryId, { excluded: input.excluded });
      if (updated === undefined) throw new Error(`No spending entry ${input.entryId}`);
      return { id: updated.id, merchant: updated.merchant, excluded: updated.excluded === true };
    },
  };
}
