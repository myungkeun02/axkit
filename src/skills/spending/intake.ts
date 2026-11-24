import type { MailMessage, PaymentNotice } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { Logger } from '../../core/log/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Classification } from './classify/classifier.js';
import type { ModelLabeler } from './classify/classifier.js';
import type { SpendingConfig } from './config.js';
import type { FxConfig } from './fx.js';
import { toHome } from './fx.js';
import type { AddResult, LedgerStore } from './ledger.js';
import type { SpendingTexts } from './locale.js';
import { cleanMerchant, merchantKey, stripCardNumbers } from './normalize.js';
import { parseNotice } from './parsers/index.js';

export const MAIL_JOB = 'spending.mail';
export const LABEL_JOB = 'spending.labels';
const LAST_SCAN_KEY = 'mail:lastScan';
const FIRST_LOOKBACK_HOURS = 720;
const LOOKBACK_HOURS = 72;
const MAIL_LIMIT = 30;
const LABEL_INTERVAL_SECONDS = 3600;
const MAX_MAIL_BODY = 6000;

export interface IntakeDeps {
  ledger: LedgerStore;
  config: SpendingConfig;
  fx: FxConfig;
  timeZone: string;
  log: Logger;
  classify: (merchant: string) => Promise<Classification>;
}

/** Card numbers are stripped before parsing so they cannot reach the ledger, labels or a log line. */
function sanitized(notice: PaymentNotice): PaymentNotice {
  return { ...notice, text: stripCardNumbers(notice.text) };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

export async function ingestNotice(deps: IntakeDeps, raw: PaymentNotice): Promise<AddResult | undefined> {
  const parsed = parseNotice(sanitized(raw), deps.timeZone);
  if (parsed === undefined) {
    deps.log.warn('spending: notice was not a readable payment', { source: raw.source });
    return undefined;
  }
  const sign = parsed.kind === 'cancel' ? -1 : 1;
  const home = toHome(parsed.amount, parsed.currency, deps.fx, parsed.statedHomeAmount);
  const merchant = cleanMerchant(parsed.merchant);
  const classification = await deps.classify(merchant);
  return deps.ledger.add({
    at: parsed.at,
    merchant,
    merchantKey: merchantKey(merchant),
    amount: sign * home.amount,
    currency: parsed.currency.toUpperCase(),
    originalAmount: sign * parsed.amount,
    fxEstimated: home.estimated,
    ...(parsed.card !== undefined ? { card: parsed.card } : {}),
    source: raw.source,
    category: classification.category,
    categorySource: classification.categorySource,
    ...(parsed.installmentMonths !== undefined ? { installmentMonths: parsed.installmentMonths } : {}),
    ...(raw.ref !== undefined ? { ref: raw.ref } : {}),
  });
}

export function registerMoneyIntake(ctx: PluginContext, deps: IntakeDeps): void {
  ctx.bus.on('money.notice', async (notice) => {
    await ingestNotice(deps, notice);
  });
}

async function scanMail(ctx: PluginContext, deps: IntakeDeps, texts: SpendingTexts, now: Date): Promise<void> {
  const mail = ctx.tryUse(Contracts.mailRead);
  if (mail === undefined) return;

  const lastScan = await ctx.kv.get<string>(LAST_SCAN_KEY);
  const sinceHours = lastScan === undefined ? FIRST_LOOKBACK_HOURS : LOOKBACK_HOURS;
  let summaries;
  try {
    summaries = await mail.search({ text: texts.receiptQuery, sinceHours, limit: MAIL_LIMIT });
  } catch (error) {
    ctx.log.warn('spending: receipt mail search failed', { error: errorName(error) });
    return;
  }

  for (const summary of summaries) {
    const ref = `mail:${summary.id}`;
    if (await deps.ledger.hasRef(ref)) continue;
    let message: MailMessage;
    try {
      message = await mail.read(summary.id);
    } catch (error) {
      ctx.log.warn('spending: receipt mail could not be read', { error: errorName(error) });
      continue;
    }
    await ingestNotice(deps, {
      source: 'mail',
      sender: message.from,
      title: message.subject,
      text: `${message.subject}\n${message.body.slice(0, MAX_MAIL_BODY)}`,
      at: message.receivedAt,
      ref,
    });
  }
  await ctx.kv.set(LAST_SCAN_KEY, now.toISOString());
}

export interface JobDeps {
  config: SpendingConfig;
  ledger: LedgerStore;
  texts: SpendingTexts;
  labeler: ModelLabeler;
  intake: IntakeDeps;
}

export function registerSpendingJobs(ctx: PluginContext, deps: JobDeps): void {
  if (deps.config.mailScan) {
    ctx.scheduler.add({
      name: MAIL_JOB,
      schedule: { kind: 'every', seconds: deps.config.mailScanSeconds },
      run: (now) => scanMail(ctx, deps.intake, deps.texts, now),
    });
  }
  if (deps.config.modelLabels) {
    ctx.scheduler.add({
      name: LABEL_JOB,
      schedule: { kind: 'every', seconds: LABEL_INTERVAL_SECONDS },
      run: () => deps.labeler.run(),
    });
  }
}
