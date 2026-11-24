import type { Notice } from '../contracts/notify.js';
import type { OutgoingMessage } from '../conversation/types.js';
import type { KeyValueStore } from '../store/types.js';

const KEY = 'notify.held';
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 3_600_000;
/** Send attempts before a notice is given up on (about a day of hourly retries at the cap). */
export const MAX_SEND_ATTEMPTS = 10;
/** More held notices than this and the foldable ones arrive as one "밤사이 소식" message. */
export const FOLD_OVER = 2;

/** A notice waiting for quiet hours to end, or for a failed send to be retried. */
export interface HeldEntry {
  notice: Notice;
  /** Failed send attempts so far. */
  attempts: number;
  /** Epoch ms; not before this. */
  retryAt?: number;
}

/** 1, 2, 4 ... minutes, at most an hour. */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

export function isExpired(notice: Notice, now: number): boolean {
  if (notice.expiresAt === undefined) return false;
  const until = Date.parse(notice.expiresAt);
  return Number.isFinite(until) && until <= now;
}

/** Buttons would be lost in a folded message, and urgent ones should stand on their own. */
export function isFoldable(notice: Notice): boolean {
  return notice.urgent !== true && (notice.choices === undefined || notice.choices.length === 0);
}

/** The message a notice carries, with every field a channel can show (buttons, pictures, the live-page handoff). */
export function messageOf(notice: Notice): OutgoingMessage {
  const message: Partial<Notice> & OutgoingMessage = { ...notice };
  delete message.kind;
  delete message.urgent;
  delete message.dedupeKey;
  delete message.expiresAt;
  return message;
}

function normalize(raw: unknown): HeldEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record['notice'] === 'object' && record['notice'] !== null) {
    const attempts = typeof record['attempts'] === 'number' ? record['attempts'] : 0;
    const retryAt = typeof record['retryAt'] === 'number' ? { retryAt: record['retryAt'] } : {};
    return { notice: record['notice'] as Notice, attempts, ...retryAt };
  }
  // queues written before retries were kept as plain notices
  if (typeof record['kind'] === 'string' && typeof record['text'] === 'string') return { notice: raw as Notice, attempts: 0 };
  return undefined;
}

export class HeldQueue {
  constructor(private readonly kv: KeyValueStore) {}

  async all(): Promise<HeldEntry[]> {
    const stored = await this.kv.get<unknown>(KEY);
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((raw) => {
      const entry = normalize(raw);
      return entry === undefined ? [] : [entry];
    });
  }

  async write(entries: readonly HeldEntry[]): Promise<void> {
    if (entries.length === 0) await this.kv.delete(KEY);
    else await this.kv.set(KEY, [...entries]);
  }

  async push(entry: HeldEntry): Promise<void> {
    await this.write([...(await this.all()), entry]);
  }
}

export interface FlushPlan {
  expired: HeldEntry[];
  due: HeldEntry[];
  waiting: HeldEntry[];
}

/** Which held notices go now: urgent ones ignore quiet hours, retries wait for their backoff. */
export function planFlush(entries: readonly HeldEntry[], now: number, quiet: boolean): FlushPlan {
  const plan: FlushPlan = { expired: [], due: [], waiting: [] };
  for (const entry of entries) {
    if (isExpired(entry.notice, now)) plan.expired.push(entry);
    else if ((quiet && entry.notice.urgent !== true) || (entry.retryAt ?? 0) > now) plan.waiting.push(entry);
    else plan.due.push(entry);
  }
  return plan;
}

/** The earliest moment one of the waiting notices can go, given when quiet hours end. */
export function nextWake(waiting: readonly HeldEntry[], quietEnd: number | undefined): number | undefined {
  let next: number | undefined;
  for (const entry of waiting) {
    const gate = entry.notice.urgent !== true && quietEnd !== undefined ? quietEnd : 0;
    const at = Math.max(entry.retryAt ?? 0, gate);
    next = next === undefined ? at : Math.min(next, at);
  }
  return next;
}
