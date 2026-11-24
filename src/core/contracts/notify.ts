import type { OutgoingMessage } from '../conversation/types.js';

/** Capability "owner.channel": a channel's direct line to the owner, for messages nobody asked for yet. */
export interface OwnerChannel {
  send(message: OutgoingMessage, options?: OwnerSendOptions): Promise<void>;
}

export interface OwnerSendOptions {
  /** Urgent messages may go to every channel at once; others go to the one the owner is on. */
  urgent?: boolean;
  /**
   * The notice kind ("browser.task", "digest" for the evening digest, "overnight" for notices held overnight), so a
   * channel that can (the app) groups or styles it; others ignore it.
   */
  kind?: string;
}

export interface Notice extends OutgoingMessage {
  /** "briefing.morning", "todo.reminder"... Used for per-kind caps and dedupe. */
  kind: string;
  /** Urgent notices ignore quiet hours (a reminder the owner set for that exact time). */
  urgent?: boolean;
  /** Same kind + key within the dedupe window is sent once. */
  dedupeKey?: string;
  /** ISO 8601. Past this a held notice is no longer worth sending ("10분 전" held overnight) and is skipped. */
  expiresAt?: string;
}

/** Bus event "notice.delivered": a notice that actually reached the owner. */
export interface NoticeDelivered {
  kind: string;
  text: string;
  /** ISO 8601. */
  at: string;
}

export type NoticeResult = 'sent' | 'held' | 'dropped';

/** Capability "core.notifier". Every proactive message goes through this, never straight to a channel. */
export interface Notifier {
  notify(notice: Notice): Promise<NoticeResult>;
}

/** Capability "core.notice-mute": kinds the owner turned off. A muted kind is dropped unless urgent. */
export interface NoticeMuter {
  mute(kind: string): Promise<void>;
  unmute(kind: string): Promise<void>;
  muted(): Promise<readonly string[]>;
}

export interface NoticeKindStats {
  kind: string;
  sent: number;
  /** Held for quiet hours, then delivered. */
  held: number;
  /** Over the daily budget and folded into the evening digest. */
  digested: number;
  /** Muted, duplicate or over the hourly cap. */
  dropped: number;
}

/** Capability "core.notice-stats": per-kind counts, kept in the store so a restart does not reset them. */
export interface NoticeStats {
  /** The last 7 days in the owner's zone, ending with `now`'s day. */
  week(now: Date): Promise<NoticeKindStats[]>;
  /** Days in the last `days` (ending today) on which the daily budget was reached. */
  overBudgetDays(now: Date, days: number): Promise<number>;
}
