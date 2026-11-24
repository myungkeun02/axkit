import type { MailMessage, MailSummary } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { monthOf } from '../../core/time/local-day.js';
import { classifyDocument } from './classify.js';
import type { ReceiptsTexts } from './locale.js';
import { fillFromFiles } from './ocr-fill.js';
import { saveMailDocument } from './save.js';
import type { SaveDeps } from './save.js';
import { addEntry, addSeen, loadSeen } from './store.js';
import type { Vault } from './vault.js';

export const SCAN_JOB = 'receipts.scan';
export const LAST_SCAN_KEY = 'lastScanAt';
const SCAN_SECONDS = 3_600;
const FIRST_SCAN_HOURS = 2_160;
const INCREMENTAL_HOURS = 72;
const SCAN_LIMIT = 30;

export interface ScanDeps {
  vault: Vault;
  texts: ReceiptsTexts;
}

export interface ScanResult {
  saved: number;
  skippedAttachments: number;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

/** Registers the hourly mail scan. Every mail source is resolved on each run. */
export function registerScan(ctx: PluginContext, deps: ScanDeps): void {
  ctx.scheduler.add({
    name: SCAN_JOB,
    schedule: { kind: 'every', seconds: SCAN_SECONDS },
    async run(now) {
      await scanOnce(ctx, deps, now);
    },
  });
}

const quiet = new WeakSet<object>();

/** One scan pass: search, skip seen ids, classify, copy into the vault and append to the month index. */
export async function scanOnce(ctx: PluginContext, deps: ScanDeps, now: Date): Promise<ScanResult> {
  const mail = ctx.tryUse(Contracts.mailRead);
  if (mail === undefined) {
    // no Gmail connected is a setup state, not a fault: say it once per process, not every hour
    if (!quiet.has(ctx)) ctx.log.info('receipts: no mail reader (Gmail not connected); scans wait for it');
    quiet.add(ctx);
    return { saved: 0, skippedAttachments: 0 };
  }

  const lastScan = await ctx.kv.get<string>(LAST_SCAN_KEY);
  const sinceHours = lastScan === undefined ? FIRST_SCAN_HOURS : INCREMENTAL_HOURS;
  let summaries: MailSummary[];
  try {
    summaries = await mail.search({ text: deps.texts.searchQuery, sinceHours, limit: SCAN_LIMIT });
  } catch (error) {
    ctx.log.warn('receipts: mail search failed', { error: errorName(error) });
    return { saved: 0, skippedAttachments: 0 };
  }

  const seen = new Set(await loadSeen(ctx.kv));
  const attachments = ctx.tryUse(Contracts.mailAttachments);
  const recognizer = ctx.tryUse(Contracts.ocr);
  const timeZone = ctx.assistant.timezone;
  const readIds: string[] = [];
  let saved = 0;
  let skippedAttachments = 0;

  for (const summary of summaries) {
    if (seen.has(summary.id)) continue;

    let message: MailMessage;
    try {
      message = await mail.read(summary.id);
    } catch (error) {
      ctx.log.warn('receipts: mail could not be read', { error: errorName(error) });
      continue;
    }
    readIds.push(summary.id);

    const doc = classifyDocument({ subject: message.subject, from: message.from, body: message.body });
    if (doc === undefined) continue;

    const saveDeps: SaveDeps = {
      vault: deps.vault,
      timeZone,
      log: ctx.log,
      ...(attachments !== undefined ? { attachments } : {}),
    };
    try {
      const result = await saveMailDocument(saveDeps, message, doc.kind);
      const filled =
        doc.amount === undefined && recognizer !== undefined
          ? await fillFromFiles(recognizer, deps.vault, result.files, ctx.log)
          : {};
      const amount = doc.amount ?? filled.amount;
      const currency = doc.currency ?? filled.currency;
      const merchant = doc.merchant ?? filled.merchant;
      const merchantKey = doc.merchantKey ?? filled.merchantKey;
      await addEntry(ctx.kv, monthOf(message.receivedAt, timeZone), {
        id: message.id,
        mailId: message.id,
        kind: doc.kind,
        subject: message.subject.slice(0, 120),
        from: message.from,
        at: message.receivedAt.toISOString(),
        ...(amount !== undefined ? { amount } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(merchant !== undefined ? { merchant } : {}),
        ...(merchantKey !== undefined ? { merchantKey } : {}),
        files: result.files,
      });
      saved += 1;
      skippedAttachments += result.skippedAttachments;
    } catch (error) {
      ctx.log.warn('receipts: document could not be saved', { error: errorName(error) });
    }
  }

  if (readIds.length > 0) await addSeen(ctx.kv, readIds);
  await ctx.kv.set(LAST_SCAN_KEY, now.toISOString());
  ctx.log.info('receipts: scan finished', { saved, skippedAttachments });
  return { saved, skippedAttachments };
}
