import type { MailMessage, MailReader, MailSummary } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { MailRef } from './tools-organize.js';
import { handleMail } from './triage-handle.js';
import { spoofReason } from './safety.js';
import type { MailIntentRegistry } from '../../core/contracts/mail-intents.js';
import { archivable, archiveCandidate, canOfferArchive, mergeCandidates, offerArchive } from './triage-archive.js';
import type { TriageConfig } from './triage-config.js';
import { isQuietSender } from './triage-config.js';
import type { TriageTexts } from './triage-locale.js';
import { senderName, triageTexts } from './triage-locale.js';
import type { Suggestion, Triage } from './triage-model.js';
import { classifyMail } from './triage-model.js';
import type { BacklogEntry } from './triage-cursor.js';
import { BACKLOG_CAP, BACKLOG_TRIES, loadCursor, lookbackHours, saveCursor, searchAll } from './triage-cursor.js';

export const TRIAGE_JOB = 'mail.triage';
export { CURSOR_KEY } from './triage-cursor.js';
export const MUTED_KEY = 'triage:muted';
const DIGEST_KEY = 'triage:digest';
const PER_RUN = 20;
const DIGEST_LINES = 12;

/** Gmail's own sorting: promotions, social and forums are never triaged; SENT/DRAFT are the owner's own mail. */
const INBOX_QUERY = 'in:inbox -from:me -category:promotions -category:social -category:forums';
const SKIP_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'SENT', 'DRAFT', 'SPAM', 'TRASH']);
const BULK_SENDER = /newsletter|mailer-daemon|marketing|promotions?@/i;

interface DigestItem {
  who: string;
  subject: string;
  summary: string;
}

interface DigestState {
  items: DigestItem[];
  lastSentAt?: string;
  /** Advertising-like mail to offer for archive with the next digest (only with Gmail 정리). */
  archive?: MailRef[];
}

/** What a sent digest still wants to ask: one archive card. */
interface FlushedDigest {
  id: string;
  archive: MailRef[];
}

export interface TriageRun {
  /** "seeded" on the very first run, which only remembers what is already there. */
  status: 'off' | 'no_mail' | 'seeded' | 'done' | 'failed';
  triaged: number;
  /** The question cards still waiting on the owner; the job does not wait for them. */
  followUps: Promise<void>;
}

const NOTHING = Promise.resolve();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function mutedSenders(kv: KeyValueStore): Promise<string[]> {
  const stored = await kv.get<unknown>(MUTED_KEY);
  return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string') : [];
}

function skipped(summary: MailSummary, quiet: readonly string[]): boolean {
  if ((summary.labels ?? []).some((label) => SKIP_LABELS.has(label))) return true;
  if (BULK_SENDER.test(summary.from)) return true;
  return isQuietSender(summary.from, quiet);
}

function suggestionLine(actions: readonly Suggestion[], texts: TriageTexts): string {
  const first = actions[0];
  if (first === undefined) return texts.suggestNothing;
  if (first.kind === 'reply') return texts.suggestReply;
  if (first.kind === 'event') return texts.suggestEvent(first.title);
  return texts.suggestTodo(first.text);
}

async function notifyHigh(ctx: PluginContext, message: MailMessage, triage: Triage, texts: TriageTexts): Promise<void> {
  const subject = message.subject === '' ? texts.noSubject : message.subject;
  const text = texts.highLine(senderName(message.from), subject, triage.summary, suggestionLine(triage.actions, texts));
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'mail.important', text, dedupeKey: message.id }).catch((error: unknown) => {
    ctx.log.warn('mail triage: notice failed', { error: errorText(error) });
  });
}

async function loadDigest(kv: KeyValueStore): Promise<DigestState> {
  const stored = await kv.get<DigestState>(DIGEST_KEY);
  return stored !== undefined && Array.isArray(stored.items) ? stored : { items: [] };
}

/** Normal mail waits for one digest every few hours; the first digest window starts at seeding. */
async function flushDigest(ctx: PluginContext, config: TriageConfig, texts: TriageTexts, now: Date): Promise<FlushedDigest | undefined> {
  const digest = await loadDigest(ctx.kv);
  if (digest.items.length === 0) return undefined;
  const last = digest.lastSentAt === undefined ? Number.NaN : Date.parse(digest.lastSentAt);
  if (Number.isFinite(last) && now.getTime() - last < config.digestHours * 3_600_000) return undefined;
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) return undefined;
  const archive = canOfferArchive(ctx) ? (digest.archive ?? []) : [];
  const lines = [texts.digestTitle(digest.items.length)];
  for (const item of digest.items.slice(0, DIGEST_LINES)) lines.push(texts.digestLine(item.who, item.subject, item.summary));
  if (digest.items.length > DIGEST_LINES) lines.push(texts.digestMore(digest.items.length - DIGEST_LINES));
  if (archive.length > 0) lines.push(texts.digestArchive(archive.length));
  await notifier.notify({ kind: 'mail.digest', text: lines.join('\n'), dedupeKey: now.toISOString() });
  await ctx.kv.set(DIGEST_KEY, { items: [], lastSentAt: now.toISOString() } satisfies DigestState);
  return { id: now.getTime().toString(36), archive };
}

async function search(ctx: PluginContext, mail: MailReader, hours: number, known: (id: string) => boolean): Promise<{ found: MailSummary[]; complete: boolean } | undefined> {
  try {
    return await searchAll(mail, { text: INBOX_QUERY, sinceHours: hours, limit: PER_RUN * 2 }, known);
  } catch (error) {
    ctx.log.warn('mail triage: search failed', { error: errorText(error) });
    return undefined;
  }
}

/** One sweep: new inbox mail → one cheap model call each → a notice, a digest line, and question cards. */
export async function triageOnce(ctx: PluginContext, config: TriageConfig, now: Date, registry?: MailIntentRegistry): Promise<TriageRun> {
  if (!config.enabled) return { status: 'off', triaged: 0, followUps: NOTHING };
  const mail = ctx.tryUse(Contracts.mailRead);
  if (mail === undefined) return { status: 'no_mail', triaged: 0, followUps: NOTHING };
  const texts = triageTexts(ctx.assistant.language);
  const cursor = await loadCursor(ctx.kv);
  const handled = new Set(cursor?.seen ?? []);
  const searched = await search(ctx, mail, lookbackHours(cursor, now), (id) => handled.has(id));
  if (searched === undefined) return { status: 'failed', triaged: 0, followUps: NOTHING };
  const found = searched.found;

  if (cursor === undefined) {
    await saveCursor(ctx.kv, { at: now.toISOString(), seen: found.map((summary) => summary.id), backlog: [] });
    await ctx.kv.set(DIGEST_KEY, { items: [], lastSentAt: now.toISOString() } satisfies DigestState);
    return { status: 'seeded', triaged: 0, followUps: NOTHING };
  }

  const seen = [...cursor.seen];
  const seenSet = new Set(seen);
  const waiting = new Map(cursor.backlog.map((entry) => [entry.id, entry.tries]));
  const backlog: BacklogEntry[] = [];
  /** Not handled this run: back to the queue, or given up (seen) after too many failures. */
  const later = (id: string, failed: boolean): void => {
    const tries = (waiting.get(id) ?? 0) + (failed ? 1 : 0);
    if (tries >= BACKLOG_TRIES) {
      ctx.log.warn('mail triage: giving up on a mail after repeated failures', { tries });
      seen.push(id);
    } else backlog.push({ id, tries });
  };
  const quiet = [...config.quietSenders, ...(await mutedSenders(ctx.kv))];
  const digest = await loadDigest(ctx.kv);
  const offers: { message: MailMessage; triage: Triage }[] = [];
  const intents = registry?.list() ?? [];
  const organize = canOfferArchive(ctx);
  const toArchive: MailRef[] = [];
  let triaged = 0;
  // the backlog first, then new mail oldest first, so a capped run leaves the newest for next time
  const fresh = found.filter((summary) => !seenSet.has(summary.id) && !waiting.has(summary.id)).reverse();
  const queue: { id: string; summary?: MailSummary }[] = [...cursor.backlog.filter((entry) => !seenSet.has(entry.id)).map((entry) => ({ id: entry.id })), ...fresh.map((summary) => ({ id: summary.id, summary }))];
  for (const { id, summary } of queue) {
    if (summary !== undefined && skipped(summary, quiet)) {
      if (organize && archivable(summary, quiet)) toArchive.push(archiveCandidate(summary));
      seen.push(summary.id);
      continue;
    }
    if (triaged >= PER_RUN) {
      later(id, false);
      continue;
    }
    let message: MailMessage;
    try {
      message = await mail.read(id);
    } catch (error) {
      ctx.log.warn('mail triage: read failed', { error: errorText(error) });
      later(id, true);
      continue;
    }
    const triage = await classifyMail(ctx, message, now, intents);
    if (triage === undefined) {
      later(id, true); // the model failed: kept in the backlog and tried again next run
      continue;
    }
    triaged += 1;
    seen.push(id);
    const spoofed = spoofReason(message);
    if (spoofed !== undefined) {
      // a forged sender gets a warning and nothing done on its behalf: no draft, no files, no pack work
      await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'mail.important', text: texts.spoofed(senderName(message.from), message.subject || texts.noSubject, spoofed), dedupeKey: `spoof:${message.id}` }).catch(() => undefined);
      continue;
    }
    await ctx.bus.emit('mail.triaged', { id: message.id, from: message.from, subject: message.subject, summary: triage.summary, kind: triage.kind, importance: triage.importance }).catch(() => undefined);
    if (triage.importance === 'high') await notifyHigh(ctx, message, triage, texts);
    if (triage.importance === 'normal') {
      digest.items.push({ who: senderName(message.from), subject: message.subject || texts.noSubject, summary: triage.summary });
    }
    const intent = intents.some((item) => item.id === triage.kind);
    if (triage.importance !== 'low' && (triage.actions.length > 0 || intent)) offers.push({ message, triage });
    if (organize && triage.importance === 'low' && triage.actions.length === 0 && archivable(message, quiet, true)) {
      toArchive.push(archiveCandidate(message));
    }
  }
  // The cursor moves to now only when the search saw every match; what was found but not handled is in the backlog.
  // a backlog over its cap would drop mail: then the cursor stays, so the dropped ones are found again next time
  await saveCursor(ctx.kv, { at: searched.complete && backlog.length <= BACKLOG_CAP ? now.toISOString() : cursor.at, seen, backlog });
  if (toArchive.length > 0) digest.archive = mergeCandidates(digest.archive ?? [], toArchive);
  await ctx.kv.set(DIGEST_KEY, digest);
  const flushed = await flushDigest(ctx, config, texts, now);

  // Question cards can wait for an answer for a long time: they run after the sweep, one mail after another.
  const followUps = (async () => {
    for (const offer of offers) await handleMail(ctx, offer.message, offer.triage, texts, { autoDraft: config.autoDraft, intents });
    if (flushed !== undefined) await offerArchive(ctx, flushed.archive, flushed.id, texts);
  })().catch((error: unknown) => ctx.log.warn('mail triage: follow-ups failed', { error: errorText(error) }));
  return { status: 'done', triaged, followUps };
}

/** Registers the triage sweep (default every 2 minutes). Mail and the model are resolved at run time. */
export function registerTriage(ctx: PluginContext, config: TriageConfig, registry?: MailIntentRegistry): void {
  if (!config.enabled) return;
  ctx.scheduler.add({
    name: TRIAGE_JOB,
    schedule: { kind: 'every', seconds: config.everyMinutes * 60 },
    async run(now) {
      const result = await triageOnce(ctx, config, now, registry);
      void result.followUps;
    },
  });
}
