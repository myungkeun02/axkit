import { Contracts } from '../../core/contracts/index.js';
import type { MailMessage } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ToolCallContext } from '../../core/tools/types.js';
import { dayRange, ymdOf, ymdPlus } from '../../core/time/local-day.js';
import { MAX_ATTACH_BYTES } from './attach.js';

const SLOT_DAYS = 7;
const WORK_START = 10;
const WORK_END = 18;
const MAX_SLOTS = 6;
const FIND_LIMIT = 5;

export interface FoundDoc {
  name: string;
  /** "~/…", what mail.draft_reply attaches. */
  path: string;
  size: number;
}

/**
 * Files on this Mac that match what a document request asks for, by name first, then by contents. Only files the
 * draft can carry; the writer picks which ones fit.
 */
export async function findRequested(ctx: PluginContext, wants: string, call: ToolCallContext): Promise<FoundDoc[]> {
  const out: FoundDoc[] = [];
  for (const kind of ['name', 'content'] as const) {
    const words = kind === 'name' ? wants.split(/\s+/).filter((word) => word.length >= 2).slice(0, 3).join(' ') : wants;
    if (words === '') continue;
    const result = await ctx.tools.execute('files.find', { query: words, kind, limit: FIND_LIMIT }, call);
    if (result.status !== 'done' || !Array.isArray(result.output)) continue;
    for (const item of result.output as { name?: unknown; path?: unknown; size?: unknown }[]) {
      if (typeof item.path !== 'string' || typeof item.name !== 'string' || typeof item.size !== 'number') continue;
      if (item.size > MAX_ATTACH_BYTES || out.some((doc) => doc.path === item.path)) continue;
      out.push({ name: item.name, path: item.path, size: item.size });
    }
    if (out.length >= FIND_LIMIT) break;
  }
  return out.slice(0, FIND_LIMIT);
}

function hourOf(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour + minute / 60;
}

/** Free weekday hours (10–18 in the owner's zone) over the next week, as "11월 25일(화) 14:00–16:00" lines. */
export async function freeSlots(ctx: PluginContext, now: Date): Promise<string[] | undefined> {
  const calendar = ctx.tryUse(Contracts.calendarRead);
  if (calendar === undefined) return undefined;
  const zone = ctx.assistant.timezone;
  const today = ymdOf(now, zone);
  const from = dayRange(ymdPlus(today, 1), zone).from;
  const to = dayRange(ymdPlus(today, SLOT_DAYS + 1), zone).from;
  let events;
  try {
    events = await calendar.listEvents({ from, to });
  } catch {
    return undefined;
  }
  const korean = ctx.assistant.language !== 'en';
  const slots: string[] = [];
  for (let offset = 1; offset <= SLOT_DAYS && slots.length < MAX_SLOTS; offset += 1) {
    const day = ymdPlus(today, offset);
    const start = dayRange(day, zone).from;
    const weekday = new Intl.DateTimeFormat(korean ? 'ko-KR' : 'en-US', { weekday: 'short', timeZone: zone }).format(start);
    if (/토|일|Sat|Sun/.test(weekday)) continue;
    const busy = events
      .filter((event) => !event.allDay && event.start.slice(0, 10) === day)
      .map((event) => [hourOf(event.start, zone), hourOf(event.end, zone)] as const)
      .sort((left, right) => left[0] - right[0]);
    if (events.some((event) => event.allDay && event.start.slice(0, 10) === day)) continue;
    let cursor = WORK_START;
    const free: [number, number][] = [];
    for (const [busyStart, busyEnd] of busy) {
      if (busyStart - cursor >= 1) free.push([cursor, Math.min(busyStart, WORK_END)]);
      cursor = Math.max(cursor, busyEnd);
    }
    if (WORK_END - cursor >= 1) free.push([cursor, WORK_END]);
    const label = `${Number(day.slice(5, 7))}${korean ? '월 ' : '/'}${Number(day.slice(8, 10))}${korean ? '일' : ''}(${weekday})`;
    const hh = (value: number): string => `${String(Math.floor(value)).padStart(2, '0')}:${value % 1 === 0 ? '00' : '30'}`;
    for (const [a, b] of free.slice(0, 2)) if (slots.length < MAX_SLOTS) slots.push(`${label} ${hh(Math.ceil(a * 2) / 2)}–${hh(Math.floor(b * 2) / 2)}`);
  }
  return slots;
}

/** Quoted the mail's first lines for the writer; the full body stays in the triage step. */
export function mailBlock(message: MailMessage): string {
  const body = message.body === '' ? message.snippet : message.body;
  return `From: ${message.from}\nSubject: ${message.subject}\n\n${body.slice(0, 4_000)}`;
}
