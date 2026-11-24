import type { MailSummary } from '../../core/contracts/index.js';
import { Contracts, MAIL_ORGANIZE_MAX } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { QuestionRequest } from '../../core/policy/questions.js';
import { TOPIC } from '../../core/policy/topics.js';
import type { MailCategory } from './organize-locale.js';
import { organizeTexts } from './organize-locale.js';
import { mailLines } from './tools-organize.js';
import type { MailRef } from './tools-organize.js';
import { isQuietSender } from './triage-config.js';
import type { TriageTexts } from './triage-locale.js';

const ASKED_BY = 'skill.mail';
const CATEGORIES: readonly MailCategory[] = ['promotions', 'social', 'updates', 'forums'];
const NEVER = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH', 'STARRED']);
// Bounces (mailer-daemon) and no-reply senders (banks, security alerts) are left alone on purpose.
const BULK_SENDER = /newsletter|marketing|promotions?@|광고/i;
const BULK_TABS = ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES'];

/** R15: one archive question per digest, never asked again. */
export function archiveTopic(digestId: string): string {
  return `mail:archive:${digestId}`;
}

/** Only when Gmail 정리 was granted and the archive tool is there. */
export function canOfferArchive(ctx: PluginContext): boolean {
  return ctx.tryUse(Contracts.mailOrganize) !== undefined;
}

export function archiveCandidate(summary: Pick<MailSummary, 'id' | 'from' | 'subject' | 'labels'>): MailRef {
  const labels = summary.labels ?? [];
  const category = CATEGORIES.find((name) => labels.includes(`CATEGORY_${name.toUpperCase()}`));
  return { id: summary.id, from: summary.from, subject: summary.subject, ...(category !== undefined ? { category } : {}) };
}

/**
 * Advertising-like mail the owner did not star, mark important or mute: a newsletter or marketing sender triage
 * skipped, or (with `lowAndIdle`, the model said low importance and nothing to do) mail in Gmail's promotions or
 * updates tab. Everything else is never offered.
 */
export function archivable(summary: MailSummary, quiet: readonly string[], lowAndIdle = false): boolean {
  const labels = summary.labels ?? [];
  if (summary.important || labels.some((label) => NEVER.has(label))) return false;
  if (isQuietSender(summary.from, quiet)) return false;
  if (BULK_SENDER.test(summary.from) || labels.includes('CATEGORY_PROMOTIONS')) return true;
  return lowAndIdle && labels.some((label) => BULK_TABS.includes(label));
}

/** Newest kept, ids unique, at most one archive call's worth. */
export function mergeCandidates(previous: readonly MailRef[], added: readonly MailRef[]): MailRef[] {
  const byId = new Map<string, MailRef>();
  for (const mail of [...previous, ...added]) {
    byId.delete(mail.id);
    byId.set(mail.id, mail);
  }
  return [...byId.values()].slice(-MAIL_ORGANIZE_MAX);
}

/**
 * One card per digest: "광고·알림 메일 N통을 보관할까요?". A yes runs mail.archive through the executor, which checks
 * each mail against the mailbox again; nothing is deleted.
 */
export async function offerArchive(ctx: PluginContext, mails: readonly MailRef[], digestId: string, texts: TriageTexts): Promise<void> {
  if (mails.length === 0 || !canOfferArchive(ctx)) return;
  const questions = ctx.tryUse(Contracts.questions);
  if (questions === undefined || !ctx.tools.list().some((tool) => tool.name === 'mail.archive')) return;
  const request: QuestionRequest = {
    topic: archiveTopic(digestId),
    askedBy: ASKED_BY,
    effects: ['write'],
    summary: texts.archiveQuestion(mails.length),
    note: [...mailLines(mails, organizeTexts(ctx.assistant.language)), texts.archiveNote].join('\n'),
    choices: [
      { id: 'yes', label: texts.archiveYes, tone: 'primary', means: 'approved' },
      { id: 'no', label: texts.no, means: 'denied' },
    ],
  };
  if (!TOPIC.test(request.topic)) return;
  try {
    const answer = await questions.ask(request);
    if (answer.status !== 'answered' || answer.means !== 'approved' || answer.reused) return;
    const outcome = await ctx.tools.execute('mail.archive', { mails }, { grounding: [] });
    if (outcome.status !== 'done') {
      ctx.log.warn('mail triage: archive did not run', { status: outcome.status });
      return;
    }
    const archived = (outcome.output as { archived?: unknown }).archived;
    const count = typeof archived === 'number' ? archived : mails.length;
    await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'mail.triage', text: texts.archived(count), dedupeKey: `archive:${digestId}` }).catch(() => undefined);
  } catch (error) {
    ctx.log.warn('mail triage: archive offer failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
