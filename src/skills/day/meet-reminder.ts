import { Contracts } from '../../core/contracts/index.js';
import type { CalendarEvent } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { meetLinkIn } from '../../core/text/meet-link.js';
import { hhmmOf } from './day-range.js';

export const MEET_JOB = 'day.meet-link';
const CHECK_SECONDS = 60;
/** The link goes out this many minutes before the start (checked every minute, so 9–11 in practice). */
const LEAD_MINUTES = 10;
const SENT_KEY = 'meet-link.sent';
const SENT_CAP = 200;

function linkOf(event: CalendarEvent): string | undefined {
  return event.meetLink ?? meetLinkIn(event.location);
}

/** Events with a video link that start in about ten minutes, and have not had their link sent. */
export async function sendMeetLinks(ctx: PluginContext, now: Date, korean: boolean): Promise<number> {
  const calendar = ctx.tryUse(Contracts.calendarRead);
  const notifier = ctx.tryUse(Contracts.notifier);
  if (calendar === undefined || notifier === undefined) return 0;
  const from = new Date(now.getTime() + (LEAD_MINUTES - 1) * 60_000);
  const to = new Date(now.getTime() + (LEAD_MINUTES + 1) * 60_000);
  const events = await calendar.listEvents({ from: new Date(now.getTime()), to }).catch(() => []);
  const sent = (await ctx.kv.get<string[]>(SENT_KEY)) ?? [];
  let count = 0;
  for (const event of events) {
    if (event.allDay) continue;
    const start = Date.parse(event.start);
    if (!Number.isFinite(start) || start < from.getTime() || start > to.getTime()) continue;
    const link = linkOf(event);
    const key = `${event.id}:${event.start}`;
    if (link === undefined || sent.includes(key)) continue;
    const time = hhmmOf(event.start, ctx.assistant.timezone) ?? '';
    const text = korean ? `10분 뒤 ${time} '${event.title}' 회의예요.\n참여: ${link}` : `'${event.title}' starts in 10 minutes (${time}).\nJoin: ${link}`;
    await notifier.notify({ kind: 'day.meeting', urgent: true, dedupeKey: `meet:${key}`, text }).catch(() => undefined);
    sent.push(key);
    count += 1;
  }
  if (count > 0) await ctx.kv.set(SENT_KEY, sent.slice(-SENT_CAP));
  return count;
}

/** Registers the minute check: every meeting with a video link gets its link ten minutes before. */
export function registerMeetLinks(ctx: PluginContext): void {
  const korean = ctx.assistant.language !== 'en';
  ctx.scheduler.add({ name: MEET_JOB, schedule: { kind: 'every', seconds: CHECK_SECONDS }, run: async (now) => void (await sendMeetLinks(ctx, now, korean)) });
}
