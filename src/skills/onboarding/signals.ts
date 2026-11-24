import { Contracts } from '../../core/contracts/index.js';
import type { Logger } from '../../core/log/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { maskForModel } from '../../core/text/mask.js';

export type SignalSource = 'mail' | 'calendar' | 'todo' | 'chat' | 'memory';

export interface SignalLine {
  source: SignalSource;
  text: string;
}

export interface SignalCollector {
  id: string;
  collect(ctx: PluginContext, now: Date): Promise<SignalLine[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAIL_HOURS = 720;
const MAIL_LIMIT = 50;
const SENDER_LIMIT = 10;
const SUBJECT_LIMIT = 30;
const CALENDAR_PAST_DAYS = 30;
const CALENDAR_FUTURE_DAYS = 14;
const CALENDAR_LIMIT = 30;
const TODO_LIMIT = 20;
const CHAT_LIMIT = 30;
const MEMORY_LIMIT = 30;

export const ROOMS_KEY = 'rooms';

export interface RoomBufferEntry {
  count: number;
  /** ISO 8601 of the last preview seen for the room. */
  lastAt: string;
}

/** Room title counts only; the message text is never stored. */
export function readRoomBuffer(value: unknown): Record<string, RoomBufferEntry> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const rooms: Record<string, RoomBufferEntry> = {};
  for (const [room, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.count !== 'number' || typeof record.lastAt !== 'string') continue;
    rooms[room] = { count: record.count, lastAt: record.lastAt };
  }
  return rooms;
}

function senderName(from: string): string | undefined {
  const withoutAddress = from.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  if (withoutAddress === '' || withoutAddress.includes('@')) return undefined;
  return withoutAddress;
}

function byCountThenName(left: [string, number], right: [string, number]): number {
  return right[1] - left[1] || left[0].localeCompare(right[0]);
}

const mailCollector: SignalCollector = {
  id: 'mail',
  async collect(ctx) {
    const reader = ctx.tryUse(Contracts.mailRead);
    if (reader === undefined) return [];
    const messages = await reader.search({ sinceHours: MAIL_HOURS, limit: MAIL_LIMIT });

    const senders = new Map<string, number>();
    for (const message of messages) {
      const name = senderName(message.from);
      if (name !== undefined) senders.set(name, (senders.get(name) ?? 0) + 1);
    }
    const lines: SignalLine[] = [...senders.entries()]
      .sort(byCountThenName)
      .slice(0, SENDER_LIMIT)
      .map(([name, count]) => ({ source: 'mail' as const, text: maskForModel(`sender: ${name} (${count})`) }));

    for (const message of messages.slice(0, SUBJECT_LIMIT)) {
      const subject = message.subject.trim();
      if (subject !== '') lines.push({ source: 'mail', text: maskForModel(`subject: ${subject}`) });
    }
    return lines;
  },
};

const calendarCollector: SignalCollector = {
  id: 'calendar',
  async collect(ctx, now) {
    const reader = ctx.tryUse(Contracts.calendarRead);
    if (reader === undefined) return [];
    const events = await reader.listEvents({
      from: new Date(now.getTime() - CALENDAR_PAST_DAYS * DAY_MS),
      to: new Date(now.getTime() + CALENDAR_FUTURE_DAYS * DAY_MS),
    });

    const titles = new Map<string, number>();
    for (const event of events) {
      const title = event.title.trim();
      if (title !== '') titles.set(title, (titles.get(title) ?? 0) + 1);
    }
    return [...titles.entries()]
      .sort(byCountThenName)
      .slice(0, CALENDAR_LIMIT)
      .map(([title, count]) => ({ source: 'calendar' as const, text: maskForModel(`event: ${title} (${count})`) }));
  },
};

const todoCollector: SignalCollector = {
  id: 'todo',
  async collect(ctx) {
    const reader = ctx.tryUse(Contracts.todoRead);
    if (reader === undefined) return [];
    const items = await reader.open();
    return items
      .slice(0, TODO_LIMIT)
      .map((item) => item.text.trim())
      .filter((text) => text !== '')
      .map((text) => ({ source: 'todo' as const, text: maskForModel(`to-do: ${text}`) }));
  },
};

function byRoomCount(left: [string, RoomBufferEntry], right: [string, RoomBufferEntry]): number {
  return right[1].count - left[1].count || left[0].localeCompare(right[0]);
}

const chatCollector: SignalCollector = {
  id: 'chat',
  async collect(ctx) {
    const rooms = readRoomBuffer(await ctx.kv.get<unknown>(ROOMS_KEY));
    return Object.entries(rooms)
      .sort(byRoomCount)
      .slice(0, CHAT_LIMIT)
      .map(([room, entry]) => ({ source: 'chat' as const, text: maskForModel(`chat room: ${room} (${entry.count})`) }));
  },
};

const memoryCollector: SignalCollector = {
  id: 'memory',
  async collect(ctx) {
    const reader = ctx.tryUse(Contracts.memoryRead);
    if (reader === undefined) return [];
    const facts = await reader.recall({ subject: 'owner', limit: MEMORY_LIMIT });
    return facts
      .map((fact) => fact.text.trim())
      .filter((text) => text !== '')
      .map((text) => ({ source: 'memory' as const, text: maskForModel(`remembered: ${text}`) }));
  },
};

/** Append a new collector here to widen the first look. */
export const defaultSignalCollectors: readonly SignalCollector[] = [
  mailCollector,
  calendarCollector,
  todoCollector,
  chatCollector,
  memoryCollector,
];

/** One failing collector is logged and skipped; the run continues. */
export async function collectSignals(
  collectors: readonly SignalCollector[],
  ctx: PluginContext,
  now: Date,
  log: Logger,
): Promise<SignalLine[]> {
  const lines: SignalLine[] = [];
  for (const collector of collectors) {
    try {
      lines.push(...(await collector.collect(ctx, now)));
    } catch (error) {
      log.warn('onboarding: a signal collector failed', {
        collector: collector.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return lines;
}
