import { z } from 'zod';
import type { AppView } from '../../../core/contracts/device-api.js';
import { ViewInputError } from '../../../core/contracts/device-api.js';
import type { SpendEntry, SpendReader } from '../../../core/contracts/index.js';
import { Contracts, SPEND_CATEGORIES } from '../../../core/contracts/index.js';
import type { PluginContext } from '../../../core/plugin/types.js';
import type { KeyValueStore } from '../../../core/store/types.js';
import { monthOf, monthPlus, monthRange, ymdOf } from '../../../core/time/local-day.js';
import type { ToolExecutor, ToolOutcome } from '../../../core/tools/types.js';
import { categoryLabel } from './spending-labels.js';

/**
 * View "spending" (docs/APP-PROTOCOL.md §5.7): a household ledger for app clients — month entries, day totals,
 * categories, budget, subscriptions and expense-claim marks — plus the owner's own reversible edits.
 *
 * Reads come from `spend.read`; edits go through the existing tools (`spending.*`, `expenses.mark`) so the
 * confirmation policy, the audit log and category learning stay exactly as in chat. Notes and the monthly budget
 * are app-only data kept in this plugin's store. Nothing here sends, pays or deletes.
 */

const NOTES_KEY = 'spending.notes';
const BUDGET_KEY = 'spending.budget';
const MAX_NOTES = 2000;
const RECENT = 20;

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const idSchema = z.string().min(1).max(120);
const categorySchema = z.enum(SPEND_CATEGORIES);

const categorizeInput = z.object({ entryId: idSchema, category: categorySchema, remember: z.boolean().default(true) });
const noteInput = z.object({ entryId: idSchema, note: z.string().max(200) });
const claimInput = z.object({ entryId: idSchema, claim: z.enum(['claim', 'personal']), remember: z.boolean().default(true) });
const excludeInput = z.object({ entryId: idSchema, excluded: z.boolean() });
const budgetInput = z.object({ monthly: z.number().positive().max(1_000_000_000_000).nullable() });
const addInput = z.object({
  merchant: z.string().trim().min(1).max(80),
  amount: z.number().positive().max(1_000_000_000_000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  category: categorySchema.optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  note: z.string().max(200).optional(),
});

type ClaimMark = 'claim' | 'personal' | 'candidate' | 'unsure';

export interface SpendingViewDeps {
  reader: () => SpendReader | undefined;
  tools: ToolExecutor;
  /** This plugin's store (notes, budget). */
  kv: KeyValueStore;
  now: () => Date;
  timeZone: string;
  language: string;
}

interface CandidateRow {
  entryId: string;
}

interface CandidatesOutput {
  candidates: CandidateRow[];
  unsure: CandidateRow[];
  grandTotal: number;
  candidateCount: number;
  unsureCount: number;
}

interface SubscriptionRow {
  key: string;
  merchant: string;
  cadence: string;
  amount: number;
  currency: string;
  nextDate: string;
  lapsed: boolean;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ViewInputError('shape');
  return parsed.data;
}

/** A tool run from the app: invalid input is the client's fault (400); a refusal is reported, not thrown. */
async function run(tools: ToolExecutor, name: string, input: unknown): Promise<unknown> {
  const outcome: ToolOutcome = await tools.execute(name, input, { grounding: [] });
  if (outcome.status === 'done') return outcome.output;
  if (outcome.status === 'invalid_input' || outcome.status === 'rejected') throw new ViewInputError('shape');
  if (outcome.status === 'denied' || outcome.status === 'expired') throw new ViewInputError('denied');
  throw new Error(`${name} failed`);
}

/** Optional skills (expenses, subscriptions) answer `undefined` when their tool is not there. */
async function optional<T>(tools: ToolExecutor, name: string, input: unknown): Promise<T | undefined> {
  try {
    const outcome = await tools.execute(name, input, { grounding: [] });
    return outcome.status === 'done' ? (outcome.output as T) : undefined;
  } catch {
    return undefined;
  }
}

async function notes(kv: KeyValueStore): Promise<Record<string, string>> {
  const stored = await kv.get<Record<string, string>>(NOTES_KEY);
  return typeof stored === 'object' && stored !== null ? stored : {};
}

async function setNote(kv: KeyValueStore, entryId: string, note: string): Promise<void> {
  const text = note.trim();
  // Insertion order: the oldest notes drop first when the cap is hit.
  const kept = Object.entries(await notes(kv)).filter(([id]) => id !== entryId);
  if (text !== '') kept.push([entryId, text]);
  await kv.set(NOTES_KEY, Object.fromEntries(kept.slice(-MAX_NOTES)));
}

function sum(entries: readonly SpendEntry[]): number {
  return Math.round(entries.reduce((total, entry) => total + entry.amount, 0) * 100) / 100;
}

export function spendingLedgerView(deps: SpendingViewDeps): AppView {
  const reader = (): SpendReader => {
    const found = deps.reader();
    if (found === undefined) throw new ViewInputError('no_spending');
    return found;
  };

  return {
    name: 'spending',
    version: 1,
    async read(query) {
      const raw = query.get('month');
      const parsed = raw === null ? undefined : monthSchema.safeParse(raw);
      if (parsed !== undefined && !parsed.success) throw new ViewInputError('month');
      const zone = deps.timeZone;
      const month = parsed?.data ?? monthOf(deps.now(), zone);
      const spend = reader();
      const entries = await spend.entries(monthRange(month, zone));
      const previous = await spend.entries(monthRange(monthPlus(month, -1), zone));
      const memo = await notes(deps.kv);
      const budget = await deps.kv.get<number>(BUDGET_KEY);

      const claims = await optional<CandidatesOutput>(deps.tools, 'expenses.candidates', { month });
      const marks = new Map<string, ClaimMark>();
      for (const row of claims?.candidates ?? []) marks.set(row.entryId, 'candidate');
      for (const row of claims?.unsure ?? []) marks.set(row.entryId, 'unsure');
      const subs = await optional<{ subscriptions: SubscriptionRow[] }>(deps.tools, 'subscriptions.list', {});

      const byCategory = new Map<string, { amount: number; count: number }>();
      const byDay = new Map<string, { total: number; count: number }>();
      for (const entry of entries) {
        const category = byCategory.get(entry.category) ?? { amount: 0, count: 0 };
        byCategory.set(entry.category, { amount: category.amount + entry.amount, count: category.count + 1 });
        const date = ymdOf(new Date(entry.at), zone);
        const day = byDay.get(date) ?? { total: 0, count: 0 };
        byDay.set(date, { total: day.total + entry.amount, count: day.count + 1 });
      }
      const sorted = [...entries].sort((a, b) => b.at.localeCompare(a.at));
      const row = (entry: SpendEntry) => ({
        id: entry.id,
        at: entry.at,
        date: ymdOf(new Date(entry.at), zone),
        merchant: entry.merchant,
        amount: entry.amount,
        category: entry.category,
        categoryLabel: categoryLabel(entry.category, deps.language),
        categorySource: entry.categorySource,
        source: entry.source,
        ...(entry.card !== undefined ? { card: entry.card } : {}),
        ...(entry.currency.toUpperCase() !== spend.homeCurrency().toUpperCase()
          ? { original: { amount: entry.originalAmount, currency: entry.currency.toUpperCase() } }
          : {}),
        ...(memo[entry.id] !== undefined ? { note: memo[entry.id] } : {}),
        ...(marks.has(entry.id) ? { claim: marks.get(entry.id) } : {}),
        hasReceipt: entry.hasReceipt === true,
      });

      return {
        month,
        currency: spend.homeCurrency(),
        total: sum(entries),
        count: entries.length,
        byCategory: [...byCategory.entries()]
          .map(([category, value]) => ({ category, label: categoryLabel(category, deps.language), amount: Math.round(value.amount * 100) / 100, count: value.count }))
          .sort((a, b) => b.amount - a.amount),
        recent: sorted.slice(0, RECENT).map((entry) => ({ at: entry.at, merchant: entry.merchant, amount: entry.amount, category: entry.category })),
        previousMonth: monthPlus(month, -1),
        previousTotal: sum(previous),
        budget: typeof budget === 'number' ? budget : null,
        days: [...byDay.entries()].map(([date, value]) => ({ date, total: Math.round(value.total * 100) / 100, count: value.count })).sort((a, b) => a.date.localeCompare(b.date)),
        entries: sorted.map(row),
        categories: SPEND_CATEGORIES.map((id) => ({ id, label: categoryLabel(id, deps.language) })),
        claims: claims === undefined ? null : { total: claims.grandTotal, candidateCount: claims.candidateCount, unsureCount: claims.unsureCount },
        subscriptions: subs === undefined ? null : subs.subscriptions.map((sub) => ({
          key: sub.key, merchant: sub.merchant, cadence: sub.cadence, amount: sub.amount, currency: sub.currency, nextDate: sub.nextDate, lapsed: sub.lapsed,
        })),
      };
    },
    actions: {
      /** Re-file an entry; with `remember` the merchant is learned for later entries (spending.set_category). */
      async categorize(body) {
        const input = parse(categorizeInput, body);
        reader();
        await run(deps.tools, 'spending.set_category', { entryId: input.entryId, category: input.category, remember: input.remember });
        return { entryId: input.entryId, category: input.category };
      },
      async note(body) {
        const input = parse(noteInput, body);
        await setNote(deps.kv, input.entryId, input.note);
        return { entryId: input.entryId, note: input.note.trim() };
      },
      /** Company claim or personal (expenses.mark); remembered per merchant unless `remember` is false. */
      async claim(body) {
        const input = parse(claimInput, body);
        await run(deps.tools, 'expenses.mark', { entryId: input.entryId, decision: input.claim, remember: input.remember });
        return { entryId: input.entryId, claim: input.claim };
      },
      /** Hide from totals (a transfer, a test charge) or bring it back. Reversible, not a delete. */
      async exclude(body) {
        const input = parse(excludeInput, body);
        await run(deps.tools, 'spending.exclude', input);
        return { entryId: input.entryId, excluded: input.excluded };
      },
      /** A cash or otherwise unseen payment, added by hand (spending.add). */
      async add(body) {
        const input = parse(addInput, body);
        reader();
        const { note, ...entry } = input;
        const output = (await run(deps.tools, 'spending.add', entry)) as { id?: string } | undefined;
        const id = typeof output?.id === 'string' ? output.id : undefined;
        if (id !== undefined && note !== undefined && note.trim() !== '') await setNote(deps.kv, id, note);
        return { added: true, ...(id !== undefined ? { entryId: id } : {}) };
      },
      async budget(body) {
        const input = parse(budgetInput, body);
        if (input.monthly === null) await deps.kv.delete(BUDGET_KEY);
        else await deps.kv.set(BUDGET_KEY, input.monthly);
        return { budget: input.monthly };
      },
    },
  };
}

/** The view as channel.app registers it (only when skill.spending provides `spend.read`). */
export function spendingView(ctx: PluginContext): AppView {
  return spendingLedgerView({
    reader: () => ctx.tryUse(Contracts.spendRead),
    tools: ctx.tools,
    kv: ctx.kv,
    now: () => ctx.clock.now(),
    timeZone: ctx.assistant.timezone,
    language: ctx.assistant.language,
  });
}
