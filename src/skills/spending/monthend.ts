import { Contracts } from '../../core/contracts/index.js';
import type { IncomingMessage, MessageHandler, Replier } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { lastDayOfMonth, ymdOf } from '../../core/time/local-day.js';
import type { SpendingConfig } from './config.js';
import type { FlaggedEntry } from './flags.js';
import { flaggedEntries } from './flags.js';
import { shortDateOf } from './format.js';
import type { LedgerStore } from './ledger.js';
import { loadPatternMonth } from './load-patterns.js';
import type { SpendingTexts } from './locale.js';

export const MONTHEND_JOB = 'spending.monthend';
export const MONTHEND_HANDLER_ID = 'spending.monthend';
export const MONTHEND_PRIORITY = 74;
const LAST_MONTH_KEY = 'monthend:last';
const MAX_LINES = 8;
const CHOICE = /^\(choice:\s*spend\.me\.(ok|more):(\d{4}-(?:0[1-9]|1[0-2]))\)$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export interface MonthEndDeps {
  config: SpendingConfig;
  ledger: LedgerStore;
  texts: SpendingTexts;
  timeZone: string;
}

const reviewedKey = (month: string): string => `reviewed:${month}`;

function flagLine(flag: FlaggedEntry, deps: MonthEndDeps): string {
  const at = new Date(flag.entry.at);
  return deps.texts.monthEndLine(
    shortDateOf(at, deps.timeZone),
    flag.entry.merchant,
    deps.texts.money(flag.entry.amount, deps.config.homeCurrency),
    flag.reason,
  );
}

function flagLineWithId(flag: FlaggedEntry, deps: MonthEndDeps): string {
  const at = new Date(flag.entry.at);
  return deps.texts.monthEndMoreLine(
    flag.entry.id,
    shortDateOf(at, deps.timeZone),
    flag.entry.merchant,
    deps.texts.money(flag.entry.amount, deps.config.homeCurrency),
    flag.reason,
  );
}

async function loadFlags(deps: MonthEndDeps, month: string): Promise<FlaggedEntry[]> {
  const loaded = await loadPatternMonth(
    deps.ledger,
    month,
    deps.timeZone,
    deps.config.homeCurrency,
    deps.config.largeAmount,
  );
  return flaggedEntries(loaded.entries, loaded.patterns);
}

async function reply(replier: Replier, message: IncomingMessage, text: string): Promise<void> {
  await replier.reply(message.conversation, { text });
}

async function runMonthEnd(ctx: PluginContext, deps: MonthEndDeps, now: Date): Promise<void> {
  const today = ymdOf(now, deps.timeZone);
  const month = today.slice(0, 7);
  if (today !== lastDayOfMonth(month)) return;
  if ((await ctx.kv.get<string>(LAST_MONTH_KEY)) === month) return;
  if ((await ctx.kv.get<string>(reviewedKey(month))) !== undefined) return;

  const loaded = await loadPatternMonth(
    deps.ledger,
    month,
    deps.timeZone,
    deps.config.homeCurrency,
    deps.config.largeAmount,
  );
  if (loaded.entries.length === 0) return;
  const flags = flaggedEntries(loaded.entries, loaded.patterns);
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('spending monthend: no notifier available');
    return;
  }

  const lines = [
    deps.texts.monthEndTitle(deps.texts.monthLabel(month)),
    deps.texts.monthEndTotal(deps.texts.money(loaded.patterns.total, loaded.patterns.currency)),
    deps.texts.monthEndChecksTitle,
  ];
  if (flags.length === 0) lines.push(deps.texts.monthEndNothing);
  else for (const flag of flags.slice(0, MAX_LINES)) lines.push(flagLine(flag, deps));

  await notifier.notify({
    kind: MONTHEND_JOB,
    dedupeKey: month,
    text: lines.join('\n'),
    choices: [
      { id: `spend.me.ok:${month}`, label: deps.texts.monthEndOkLabel },
      { id: `spend.me.more:${month}`, label: deps.texts.monthEndMoreLabel },
    ],
  });
  await ctx.kv.set(LAST_MONTH_KEY, month);
}

/** Registers the last-day card and the owner-only buttons that review or expand it. */
export function registerMonthEnd(ctx: PluginContext, deps: MonthEndDeps): void {
  ctx.scheduler.add({
    name: MONTHEND_JOB,
    schedule: { kind: 'daily', at: deps.config.monthEndAt as `${number}:${number}` },
    run: (now) => runMonthEnd(ctx, deps, now),
  });

  const handler: MessageHandler = {
    id: MONTHEND_HANDLER_ID,
    priority: MONTHEND_PRIORITY,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      const match = CHOICE.exec(message.text.trim());
      if (match === null) return 'pass';
      const action = match[1];
      const month = match[2];
      if (month === undefined || !MONTH.test(month)) return 'pass';

      if (action === 'ok') {
        await ctx.kv.set(reviewedKey(month), ctx.clock.now().toISOString());
        await reply(replier, message, deps.texts.monthEndAck(deps.texts.monthLabel(month)));
        return 'handled';
      }

      const flags = await loadFlags(deps, month);
      if (flags.length === 0) {
        await reply(replier, message, deps.texts.monthEndNothing);
        return 'handled';
      }
      const lines = [deps.texts.monthEndMoreTitle(flags.length)];
      for (const flag of flags) lines.push(flagLineWithId(flag, deps));
      lines.push(deps.texts.monthEndMoreHint);
      await reply(replier, message, lines.join('\n'));
      return 'handled';
    },
  };
  ctx.registerHandler(handler);
}
