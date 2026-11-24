import type { MailDraft } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { Choice, IncomingMessage, MessageHandler, Replier } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { monthPlus, ymdOf } from '../../core/time/local-day.js';
import { YM } from './config.js';
import { messageOf } from './deps.js';
import type { ExpenseDeps } from './deps.js';
import { shortDate, stripCardNumbers } from './mail.js';
import { loadReport } from './report.js';

export const MONTHLY_JOB = 'expenses.monthly';
export const HANDLER_ID = 'expenses.choices';
export const HANDLER_PRIORITY = 75;
const LAST_MONTH_KEY = 'monthly:last';
const MAX_REVIEW = 5;
const MAX_CHOICE_ID = 90;

async function reply(
  replier: Replier,
  message: IncomingMessage,
  text: string,
  choices?: readonly Choice[],
): Promise<void> {
  await replier.reply(message.conversation, {
    text,
    ...(choices !== undefined && choices.length > 0 ? { choices } : {}),
  });
}

async function runMonthly(ctx: PluginContext, deps: ExpenseDeps, now: Date): Promise<void> {
  const today = ymdOf(now, ctx.assistant.timezone);
  if (Number(today.slice(8, 10)) !== deps.config.summaryDay) return;
  const month = monthPlus(today.slice(0, 7), -1);
  const last = await ctx.kv.get<string>(LAST_MONTH_KEY);
  if (last === month) return;

  const loaded = await loadReport(ctx, deps, month);
  if (loaded === undefined) {
    ctx.log.warn('expenses monthly: spend data is not available');
    return;
  }
  const { report } = loaded;
  if (report.candidateCount === 0 && report.unsureCount === 0) {
    await ctx.kv.set(LAST_MONTH_KEY, month);
    return;
  }
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('expenses monthly: no notifier available');
    return;
  }

  const texts = deps.texts;
  const lines = [texts.monthlyTitle(month)];
  for (const total of report.totals) {
    lines.push(texts.monthlyRuleLine(total.name ?? texts.noRule, total.count, texts.money(total.total, report.currency)));
  }
  if (report.candidateCount > 0) lines.push(texts.monthlyTotal(texts.money(report.grandTotal, report.currency)));
  if (report.unsureCount > 0) lines.push(texts.monthlyUnsure(report.unsureCount));

  const choices: Choice[] = [{ id: `exp.review:${month}`, label: texts.reviewChoice }];
  if (report.candidateCount > 0) choices.push({ id: `exp.draft:${month}`, label: texts.draftChoice });
  await notifier.notify({
    kind: 'expenses.monthly',
    dedupeKey: `expenses.monthly:${month}`,
    text: lines.join('\n'),
    choices,
  });
  await ctx.kv.set(LAST_MONTH_KEY, month);
}

async function review(
  ctx: PluginContext,
  deps: ExpenseDeps,
  month: string,
  message: IncomingMessage,
  replier: Replier,
): Promise<void> {
  const loaded = await loadReport(ctx, deps, month);
  if (loaded === undefined) {
    await reply(replier, message, deps.texts.notConnected);
    return;
  }
  const texts = deps.texts;
  const unsure = loaded.report.items.filter((item) => item.status === 'unsure');
  const lines = [texts.reviewTitle(month, loaded.report.candidateCount)];
  const choices: Choice[] = [];
  for (const item of unsure.slice(0, MAX_REVIEW)) {
    const merchant = stripCardNumbers(item.entry.merchant);
    lines.push(
      `- ${texts.reviewLine(
        shortDate(item.entry.at, ctx.assistant.timezone),
        merchant === '' ? texts.unknownMerchant : merchant,
        texts.money(item.entry.amount, loaded.currency),
        item.ruleName ?? texts.noRule,
      )}`,
    );
    const claimId = `exp.mark:${item.entry.id}:claim`;
    const personalId = `exp.mark:${item.entry.id}:personal`;
    if (claimId.length <= MAX_CHOICE_ID && personalId.length <= MAX_CHOICE_ID) {
      choices.push({ id: claimId, label: texts.markClaimLabel }, { id: personalId, label: texts.markPersonalLabel });
    }
  }
  if (unsure.length === 0) lines.push(texts.noUnsure);
  else if (unsure.length > MAX_REVIEW) lines.push(texts.reviewMore(unsure.length - MAX_REVIEW));
  await reply(replier, message, lines.join('\n'), choices);
}

async function mark(
  ctx: PluginContext,
  deps: ExpenseDeps,
  entryId: string,
  decision: 'claim' | 'personal',
  message: IncomingMessage,
  replier: Replier,
): Promise<void> {
  const outcome = await ctx.tools.execute('expenses.mark', { entryId, decision, remember: true });
  await reply(replier, message, outcome.status === 'done' ? deps.texts.markDone(decision) : deps.texts.markFailed);
}

type ParsedDraft =
  | { kind: 'no_recipient'; hint: string }
  | { kind: 'text'; subject: string; body: string }
  | { kind: 'drafted'; draftId: string; subject: string; body: string; note: string };

function draftOutput(value: unknown): ParsedDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status === 'no_recipient' && typeof record.hint === 'string') {
    return { kind: 'no_recipient', hint: record.hint };
  }
  if (typeof record.subject !== 'string' || typeof record.body !== 'string') return undefined;
  if (typeof record.draftId !== 'string') {
    return { kind: 'text', subject: record.subject, body: record.body };
  }
  if (typeof record.note !== 'string') return undefined;
  return {
    kind: 'drafted',
    draftId: record.draftId,
    subject: record.subject,
    body: record.body,
    note: record.note,
  };
}

async function draft(
  ctx: PluginContext,
  deps: ExpenseDeps,
  month: string,
  message: IncomingMessage,
  replier: Replier,
): Promise<void> {
  const outcome = await ctx.tools.execute('expenses.draft_claim_mail', { month });
  const output = outcome.status === 'done' ? draftOutput(outcome.output) : undefined;
  if (output === undefined) {
    await reply(replier, message, deps.texts.draftFailed);
    return;
  }
  if (output.kind === 'no_recipient') {
    await reply(replier, message, output.hint);
    return;
  }
  if (output.kind === 'text') {
    await reply(replier, message, deps.texts.draftReply(output.subject, output.body, deps.texts.composerMissing));
    return;
  }
  const sendId = `exp.send:${output.draftId}`;
  const choices: Choice[] | undefined =
    sendId.length <= MAX_CHOICE_ID ? [{ id: sendId, label: deps.texts.sendChoice }] : undefined;
  await reply(replier, message, deps.texts.draftReply(output.subject, output.body, output.note), choices);
}

async function send(
  ctx: PluginContext,
  deps: ExpenseDeps,
  draftId: string,
  message: IncomingMessage,
  replier: Replier,
): Promise<void> {
  const drafter = ctx.tryUse(Contracts.mailDraft);
  const hasTool = ctx.tools.list().some((tool) => tool.name === 'mail.send_draft');
  if (drafter === undefined || !hasTool) {
    await reply(replier, message, deps.texts.mailNotConnected);
    return;
  }
  let draft: MailDraft;
  try {
    draft = await drafter.getDraft(draftId);
  } catch (error) {
    ctx.log.warn('expenses: draft could not be read', { error: messageOf(error) });
    await reply(replier, message, deps.texts.sendFailed);
    return;
  }
  const outcome = await ctx.tools.execute('mail.send_draft', {
    draftId,
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
  });
  if (outcome.status === 'done') {
    await reply(replier, message, deps.texts.sent);
  } else if (outcome.status === 'denied' || outcome.status === 'expired') {
    await reply(replier, message, deps.texts.notSent);
  } else {
    await reply(replier, message, deps.texts.sendFailed);
  }
}

/** Registers the monthly summary job and the owner-only button handler. */
export function registerMonthly(ctx: PluginContext, deps: ExpenseDeps): void {
  ctx.scheduler.add({
    name: MONTHLY_JOB,
    schedule: { kind: 'daily', at: deps.config.summaryAt as `${number}:${number}` },
    run: (now) => runMonthly(ctx, deps, now),
  });

  const handler: MessageHandler = {
    id: HANDLER_ID,
    priority: HANDLER_PRIORITY,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      const choice = /^\(choice:\s*(exp\..+)\)$/.exec(message.text.trim())?.[1];
      if (choice === undefined) return 'pass';

      const reviewMatch = /^exp\.review:(\d{4}-\d{2})$/.exec(choice);
      if (reviewMatch !== null && YM.test(reviewMatch[1] ?? '')) {
        await review(ctx, deps, reviewMatch[1] ?? '', message, replier);
        return 'handled';
      }
      const markMatch = /^exp\.mark:(.+):(claim|personal)$/.exec(choice);
      if (markMatch !== null) {
        const decision = markMatch[2] === 'claim' ? 'claim' : 'personal';
        await mark(ctx, deps, markMatch[1] ?? '', decision, message, replier);
        return 'handled';
      }
      const draftMatch = /^exp\.draft:(\d{4}-\d{2})$/.exec(choice);
      if (draftMatch !== null && YM.test(draftMatch[1] ?? '')) {
        await draft(ctx, deps, draftMatch[1] ?? '', message, replier);
        return 'handled';
      }
      const sendMatch = /^exp\.send:(.+)$/.exec(choice);
      if (sendMatch !== null) {
        await send(ctx, deps, sendMatch[1] ?? '', message, replier);
        return 'handled';
      }
      return 'pass';
    },
  };
  ctx.registerHandler(handler);
}
