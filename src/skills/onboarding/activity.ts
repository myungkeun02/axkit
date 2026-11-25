import { Contracts } from '../../core/contracts/index.js';
import type { MailSummary } from '../../core/contracts/mail.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { maskForModel } from '../../core/text/mask.js';

/** One mail as the first look keeps it: who, what, when; never the body. */
export interface MailSeen {
  from: string;
  subject: string;
  /** ISO 8601. */
  at: string;
  /** The owner sent it. */
  sent: boolean;
}

/** A sender's signature block (masked), read once per sender: names, titles and teams show there. */
export interface Signature {
  from: string;
  text: string;
}

export interface EventSeen {
  title: string;
  /** ISO 8601 or a date for all-day events. */
  start: string;
  allDay: boolean;
  attendees: readonly string[];
}

export interface Activity {
  mails: MailSeen[];
  signatures: Signature[];
  /** "Name <a@b>" or "a@b" of everyone on To/Cc of the mails read, with how often. */
  recipients: Map<string, number>;
  events: EventSeen[];
  /** The owner's own addresses (from the mail they sent). */
  ownerEmails: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAIL_DAYS = 180;
const MAX_MAILS = 3_000;
const PAGE = 500;
const MAX_READS = 150;
const CALENDAR_PAST_DAYS = 180;
const CALENDAR_FUTURE_DAYS = 30;
const SIGNATURE_LINES = 6;
const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM'];
const QUOTE_START = /^(>|-{2,}\s*(original|forwarded)|on .+ wrote:|20\d\d.+작성:|.+님이 작성:|보낸 사람:|from:\s)/i;

function addressOf(from: string): string | undefined {
  return /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1]?.toLowerCase() ?? (/^[^\s@<>]+@[^\s@<>]+$/.test(from.trim()) ? from.trim().toLowerCase() : undefined);
}

/** The last few lines before the quoted part of a reply: where a sender's name, title and team usually are. */
export function signatureOf(body: string): string | undefined {
  const lines: string[] = [];
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (QUOTE_START.test(line.trim())) break;
    lines.push(line.trim());
  }
  const tail = lines.filter((line) => line !== '').slice(-SIGNATURE_LINES);
  const text = maskForModel(tail.join(' / ')).slice(0, 300);
  return text.length >= 4 ? text : undefined;
}

async function mails(ctx: PluginContext, signal: AbortSignal): Promise<MailSummary[]> {
  const reader = ctx.tryUse(Contracts.mailRead);
  if (reader === undefined) return [];
  const query = { sinceHours: MAIL_DAYS * 24, limit: PAGE };
  if (reader.searchPage === undefined) return await reader.search({ ...query, limit: MAX_MAILS });
  const out: MailSummary[] = [];
  let token: string | undefined;
  do {
    if (signal.aborted) break;
    const page = await reader.searchPage(query, token);
    out.push(...page.messages);
    token = page.nextPageToken;
  } while (token !== undefined && out.length < MAX_MAILS);
  return out.slice(0, MAX_MAILS);
}

/** Mail of the last six months and the calendar around now, read once per run; a failing part is left empty. */
export async function collectActivity(ctx: PluginContext, now: Date, signal: AbortSignal): Promise<Activity> {
  const activity: Activity = { mails: [], signatures: [], recipients: new Map(), events: [], ownerEmails: [] };
  try {
    const found = await mails(ctx, signal);
    const owner = new Set<string>();
    for (const mail of found) {
      const sent = mail.labels?.includes('SENT') === true;
      const address = addressOf(mail.from);
      if (sent && address !== undefined) owner.add(address);
      activity.mails.push({ from: mail.from, subject: mail.subject, at: mail.receivedAt.toISOString(), sent });
    }
    activity.ownerEmails = [...owner];
    await readSome(ctx, found, owner, activity, signal);
  } catch (error) {
    ctx.log.warn('onboarding: mail could not be read for the first look', { error: error instanceof Error ? error.name : 'unknown' });
  }
  try {
    const reader = ctx.tryUse(Contracts.calendarRead);
    const events = reader === undefined ? [] : await reader.listEvents({ from: new Date(now.getTime() - CALENDAR_PAST_DAYS * DAY_MS), to: new Date(now.getTime() + CALENDAR_FUTURE_DAYS * DAY_MS) });
    activity.events = events.map((event) => ({ title: event.title, start: event.start, allDay: event.allDay, attendees: event.attendees ?? [] }));
  } catch (error) {
    ctx.log.warn('onboarding: the calendar could not be read for the first look', { error: error instanceof Error ? error.name : 'unknown' });
  }
  return activity;
}

/** One mail per sender (person-to-person, newest first): their signature, and who else was on it. */
async function readSome(ctx: PluginContext, found: readonly MailSummary[], owner: ReadonlySet<string>, activity: Activity, signal: AbortSignal): Promise<void> {
  const reader = ctx.tryUse(Contracts.mailRead);
  if (reader === undefined) return;
  const senders = new Set<string>();
  let reads = 0;
  for (const mail of found) {
    if (reads >= MAX_READS || signal.aborted) break;
    if (mail.labels?.some((label) => BULK_LABELS.includes(label)) === true) continue;
    const address = addressOf(mail.from) ?? mail.from;
    if (senders.has(address)) continue;
    senders.add(address);
    reads += 1;
    try {
      const message = await reader.read(mail.id);
      if (message.bulk === true) continue;
      for (const to of [...message.to, ...message.cc]) {
        const key = to.trim();
        if (key !== '' && !owner.has(addressOf(key) ?? '')) activity.recipients.set(key, (activity.recipients.get(key) ?? 0) + 1);
      }
      const signature = owner.has(address) ? undefined : signatureOf(message.body);
      if (signature !== undefined) activity.signatures.push({ from: mail.from, text: signature });
    } catch {
      // one unreadable mail is skipped
    }
  }
}
