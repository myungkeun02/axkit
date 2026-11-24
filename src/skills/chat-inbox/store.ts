import { z } from 'zod';
import type { ChatApp } from '../../core/contracts/index.js';
import type { Logger } from '../../core/log/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { dateSpecSchema, timeSpecSchema } from '../../core/time/date-spec.js';

export const MAX_PENDING = 100;
export const MAX_QUEUE = 20;
export const MAX_SUGGESTIONS = 50;

const PENDING_KEY = 'pending';
const QUEUE_KEY = 'queue';
const SUGGESTION_KEY = 'suggestions';
const MUTED_KEY = 'muted';

const chatAppSchema = z.enum(['kakao', 'discord']);
/** Where an appointment line came from: a screen-read chat app, or a text message the phone forwarded. */
const inboxAppSchema = z.enum(['kakao', 'discord', 'sms']);
export type InboxApp = ChatApp | 'sms';

const pendingSchema = z.object({
  app: chatAppSchema,
  room: z.string().min(1),
  /** ISO 8601 of the first preview; the digest ages the room from here. */
  firstAt: z.string(),
  lastText: z.string(),
  unread: z.number().int().min(0),
});
export type PendingEntry = z.infer<typeof pendingSchema>;

const queueSchema = z.object({
  id: z.string().min(1),
  app: inboxAppSchema,
  room: z.string().min(1),
  text: z.string(),
  at: z.string(),
  ref: z.string().min(1),
  tries: z.number().int().min(0),
});
export type QueuedPreview = z.infer<typeof queueSchema>;

const suggestionSchema = z.object({
  id: z.string().min(1),
  app: inboxAppSchema,
  room: z.string().min(1),
  text: z.string(),
  title: z.string().min(1),
  date: dateSpecSchema,
  time: timeSpecSchema.optional(),
  evidence: z.string(),
  /** Owner-local day the line was seen; "내일" means the day after this, not after the button press. */
  seenYmd: z.string().optional(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

/** Stable key for one room in one app. */
export function roomKey(app: InboxApp, room: string): string {
  return `${app}:${room}`;
}

function readList<T>(raw: unknown, schema: z.ZodType<T>, log: Logger, label: string): T[] {
  if (!Array.isArray(raw)) return [];
  const items: T[] = [];
  for (const candidate of raw) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) items.push(parsed.data);
    else log.warn('chat-inbox: dropping an unreadable entry', { collection: label });
  }
  return items;
}

function readStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Bounded repository over this plugin's key-value namespace. */
export class ChatInboxStore {
  private pending: PendingEntry[] = [];
  private queueItems: QueuedPreview[] = [];
  private suggestionItems: Suggestion[] = [];
  private mutedRooms: string[] = [];

  constructor(
    private readonly kv: KeyValueStore,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    this.pending = readList(await this.kv.get<unknown>(PENDING_KEY), pendingSchema, this.log, 'pending');
    this.queueItems = readList(await this.kv.get<unknown>(QUEUE_KEY), queueSchema, this.log, 'queue');
    this.suggestionItems = readList(await this.kv.get<unknown>(SUGGESTION_KEY), suggestionSchema, this.log, 'suggestion');
    this.mutedRooms = readStrings(await this.kv.get<unknown>(MUTED_KEY));
  }

  pendingEntries(): readonly PendingEntry[] {
    return this.pending;
  }

  async setPending(entries: readonly PendingEntry[]): Promise<void> {
    this.pending = [...entries].slice(0, MAX_PENDING);
    await this.kv.set(PENDING_KEY, this.pending);
  }

  /** Keeps the first sighting time; only the latest text and unread count change. */
  async upsertPending(entry: PendingEntry): Promise<void> {
    const key = roomKey(entry.app, entry.room);
    const index = this.pending.findIndex((candidate) => roomKey(candidate.app, candidate.room) === key);
    const existing = index >= 0 ? this.pending[index] : undefined;
    if (existing === undefined) {
      this.pending.push(entry);
      if (this.pending.length > MAX_PENDING) {
        this.pending.sort((a, b) => a.firstAt.localeCompare(b.firstAt));
        this.pending.splice(0, this.pending.length - MAX_PENDING);
      }
    } else {
      this.pending[index] = { ...entry, firstAt: existing.firstAt };
    }
    await this.kv.set(PENDING_KEY, this.pending);
  }

  async removePending(key: string): Promise<void> {
    const before = this.pending.length;
    this.pending = this.pending.filter((entry) => roomKey(entry.app, entry.room) !== key);
    if (this.pending.length !== before) await this.kv.set(PENDING_KEY, this.pending);
  }

  queued(): readonly QueuedPreview[] {
    return this.queueItems;
  }

  async enqueue(entry: QueuedPreview): Promise<void> {
    if (this.queueItems.some((candidate) => candidate.ref === entry.ref)) return;
    this.queueItems.push(entry);
    if (this.queueItems.length > MAX_QUEUE) {
      this.queueItems.splice(0, this.queueItems.length - MAX_QUEUE);
    }
    await this.kv.set(QUEUE_KEY, this.queueItems);
  }

  async setQueue(entries: readonly QueuedPreview[]): Promise<void> {
    this.queueItems = [...entries].slice(0, MAX_QUEUE);
    await this.kv.set(QUEUE_KEY, this.queueItems);
  }

  suggestions(): readonly Suggestion[] {
    return this.suggestionItems;
  }

  getSuggestion(id: string): Suggestion | undefined {
    return this.suggestionItems.find((candidate) => candidate.id === id);
  }

  async addSuggestion(suggestion: Suggestion): Promise<void> {
    this.suggestionItems.push(suggestion);
    if (this.suggestionItems.length > MAX_SUGGESTIONS) {
      this.suggestionItems.splice(0, this.suggestionItems.length - MAX_SUGGESTIONS);
    }
    await this.kv.set(SUGGESTION_KEY, this.suggestionItems);
  }

  async removeSuggestion(id: string): Promise<void> {
    const before = this.suggestionItems.length;
    this.suggestionItems = this.suggestionItems.filter((candidate) => candidate.id !== id);
    if (this.suggestionItems.length !== before) await this.kv.set(SUGGESTION_KEY, this.suggestionItems);
  }

  isMuted(app: InboxApp, room: string): boolean {
    return this.mutedRooms.includes(room) || this.mutedRooms.includes(roomKey(app, room));
  }

  async muteRoom(subject: string): Promise<void> {
    if (this.mutedRooms.includes(subject)) return;
    this.mutedRooms.push(subject);
    await this.kv.set(MUTED_KEY, this.mutedRooms);
  }

  async unmuteRoom(subject: string): Promise<void> {
    const before = this.mutedRooms.length;
    this.mutedRooms = this.mutedRooms.filter((entry) => entry !== subject);
    if (this.mutedRooms.length !== before) await this.kv.set(MUTED_KEY, this.mutedRooms);
  }
}
