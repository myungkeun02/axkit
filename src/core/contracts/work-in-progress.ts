import type { ConversationRef } from '../conversation/types.js';

/**
 * The owner's "지금 하고 있는 일 / 최근에 끝난 일": every long task (a dev job, a browser task or errand, and later a
 * first-look scan or a routine run) registers here, so "어떻게 됐어?" gets a real answer. The registry only shows
 * work; each producer still owns running it, its own persisted state, and telling the owner the result.
 */

/** `queued` waits behind another task; `waiting` stopped for the owner (a login, a button to press). */
export type WorkStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'interrupted';

/** Open set: "dev", "browser", "errand", "first-look", "routine"... */
export type WorkKind = string;

export interface WorkItem {
  /** Unique across producers; prefix it with the producer, e.g. "dev:job_1a2b3c4d". */
  id: string;
  kind: WorkKind;
  /** Owner-readable, in the assistant language. */
  title: string;
  status: WorkStatus;
  /** Owner-readable step, e.g. "테스트 중". */
  phase?: string;
  /** ISO times. */
  startedAt: string;
  updatedAt: string;
  /** The conversation the request came from, when a conversation turn started it. */
  origin?: ConversationRef;
  /** The outcome in one or two owner-readable lines, once there is one. */
  summary?: string;
  /** A page, branch or pull request the outcome points at. */
  link?: string;
  /** The item this one was split off from (a sub-session under its lead, a bot's part of a delegation). */
  parent?: string;
}

/** Capability "work.in-progress". Upserts are cheap and idempotent; producers call it on every change. */
export interface WorkInProgress {
  upsert(item: WorkItem): Promise<void>;
  /** Active items first (newest start first), then finished ones (most recently updated first). */
  list(): Promise<readonly WorkItem[]>;
  get(id: string): Promise<WorkItem | undefined>;
}

export const ACTIVE_WORK: readonly WorkStatus[] = ['queued', 'running', 'waiting'];

export function isActiveWork(status: WorkStatus): boolean {
  return ACTIVE_WORK.includes(status);
}
