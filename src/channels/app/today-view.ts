import { Contracts } from '../../core/contracts/index.js';
import type { ChatApp } from '../../core/contracts/index.js';
import type { AppView } from '../../core/contracts/device-api.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { dayRange, ymdOf } from '../../core/time/local-day.js';
import type { AppEventLog } from './log.js';
import type { GeoCache } from './views/routes.js';

const MAX_ROWS = 5;
/** Mail that waits at least this long counts as a reply the owner owes. */
const MAIL_OLDER_THAN_HOURS = 1;
const MAIL_NEWER_THAN_DAYS = 7;
/** The mail check is a network call; the home screen refreshes often. */
const MAIL_CACHE_MS = 5 * 60_000;

interface ReplyRow {
  from: string;
  text: string;
  source: string;
  at: string;
}

const SOURCE_LABELS: Record<'ko' | 'en', Record<ChatApp | 'mail', string>> = {
  ko: { kakao: '카톡', discord: '디스코드', mail: '메일' },
  en: { kakao: 'KakaoTalk', discord: 'Discord', mail: 'Mail' },
};

/** "Name <a@b.c>" → "Name"; a bare address stays as it is. */
function senderName(from: string): string {
  const name = from.replace(/\s*<[^>]*>\s*$/, '').replace(/^"(.*)"$/, '$1').trim();
  return name === '' ? from.trim() : name;
}

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The home screen's summary (docs/APP-PROTOCOL.md §5.1): today's events, open to-dos due by today, cards waiting for an
 * answer, replies the owner owes, and today's spending. Each part is optional — a missing calendar, to-do, inbox or
 * spending skill leaves its part out (`null`, or no `spend`), never an error.
 */
export function todayView(ctx: PluginContext, log: AppEventLog, geo?: GeoCache): AppView {
  let mailCache: { at: number; rows: ReplyRow[] } | undefined;
  const lang = ctx.assistant.language === 'en' ? 'en' : 'ko';

  async function mailReplies(now: Date): Promise<ReplyRow[] | undefined> {
    const mail = ctx.tryUse(Contracts.mailAwaiting);
    if (mail === undefined) return undefined;
    if (mailCache !== undefined && now.getTime() - mailCache.at < MAIL_CACHE_MS) return mailCache.rows;
    const list = await mail
      .awaitingReply({ olderThanHours: MAIL_OLDER_THAN_HOURS, newerThanDays: MAIL_NEWER_THAN_DAYS, limit: MAX_ROWS })
      .catch(() => undefined);
    if (list === undefined) return mailCache?.rows ?? [];
    const rows = list.map((summary) => ({
      from: senderName(summary.from),
      text: cut(summary.subject !== '' ? summary.subject : summary.snippet, 120),
      source: SOURCE_LABELS[lang].mail,
      at: summary.receivedAt.toISOString(),
    }));
    mailCache = { at: now.getTime(), rows };
    return rows;
  }

  async function replies(now: Date): Promise<ReplyRow[] | null> {
    const chat = ctx.tryUse(Contracts.chatAwaiting);
    const chats = chat === undefined
      ? undefined
      : (await chat.awaiting(MAX_ROWS).catch(() => [])).map((row) => ({
          from: row.room,
          text: cut(row.text, 120),
          source: SOURCE_LABELS[lang][row.app],
          at: row.at,
        }));
    const mails = await mailReplies(now);
    if (chats === undefined && mails === undefined) return null;
    return [...(chats ?? []), ...(mails ?? [])].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ROWS);
  }

  async function spend(range: { from: Date; to: Date }): Promise<{ amount: number; count: number } | undefined> {
    const reader = ctx.tryUse(Contracts.spendRead);
    if (reader === undefined) return undefined;
    const entries = await reader.entries(range).catch(() => undefined);
    if (entries === undefined) return undefined;
    const amount = entries.reduce((sum, entry) => sum + entry.amount, 0);
    return { amount: Math.round(amount * 100) / 100, count: entries.length };
  }

  return {
    name: 'today',
    version: 1,
    async read() {
      const now = ctx.clock.now();
      const ymd = ymdOf(now, ctx.assistant.timezone);
      const range = dayRange(ymd, ctx.assistant.timezone);
      const calendar = ctx.tryUse(Contracts.calendarRead);
      const todo = ctx.tryUse(Contracts.todoRead);
      const events = calendar === undefined
        ? null
        : (await calendar.listEvents(range).catch(() => []))
            .filter((event) => event.allDay || Date.parse(event.end) > now.getTime())
            .slice(0, MAX_ROWS)
            .map((event) => ({ id: event.id, title: event.title, start: event.start, end: event.end, allDay: event.allDay, ...(event.location !== undefined ? { place: event.location } : {}), ...(event.calendar !== undefined ? { calendar: event.calendar } : {}), source: 'calendar' }));
      const withGeo = events === null || geo === undefined ? events : await geo.decorate(events);
      const todos = todo === undefined
        ? null
        : (await todo.open().catch(() => []))
            .filter((item) => item.due === undefined || item.due.slice(0, 10) <= ymd)
            .slice(0, MAX_ROWS)
            .map((item) => ({ text: item.text, ...(item.due !== undefined ? { due: item.due } : {}), source: 'todo' }));
      const spent = await spend(range);
      return {
        date: ymd,
        events: withGeo,
        todos,
        pendingCards: (await log.openCards()).length,
        replies: await replies(now),
        ...(spent !== undefined ? { spend: spent } : {}),
      };
    },
  };
}
