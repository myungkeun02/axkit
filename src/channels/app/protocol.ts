import { z } from 'zod';
import type { LiveHandoff } from '../../core/conversation/types.js';
import type { Effect } from '../../core/policy/types.js';

/**
 * App channel protocol v1 (docs/ARCHITECTURE.md §9.7). Every client — the Android app, a desktop app — sees the same
 * ordered event log: `seq` only grows, so a client that was away asks for `events?after=<last seq>` or reconnects the
 * stream with `Last-Event-ID`.
 */
export const PROTOCOL_VERSION = 1;

export interface ChoiceView {
  id: string;
  label: string;
}

/** §7.5: a file the app fetches with its own token at `url` (`files/<id>`). */
export interface AttachmentView {
  id: string;
  name: string;
  contentType: string;
  size?: number;
  url: string;
}

/** Pictures an event may carry: served files, and at most one external https image the app loads directly. */
export interface EventMedia {
  attachments?: AttachmentView[];
  imageUrl?: string;
}

export type CardState = 'open' | 'approved' | 'denied' | 'expired' | 'closed' | 'edit';

/** One answer on a card (`card-options`); the recommended one is `primary`, "don't" is `danger`. */
export interface CardOptionView {
  id: string;
  label: string;
  tone?: 'primary' | 'danger' | 'neutral';
  detail?: string;
}

/** A room (R1, R16, R17): a bot id, a team id or a meeting room; absent means the main chat. */
export interface RoomFields {
  channel?: string;
  author?: { id: string; name: string };
  /** Bot-to-bot lines: who it was said to. */
  to?: { id: string; name: string };
}

export type AppEvent =
  | ({
      type: 'message';
      seq: number;
      at: string;
      role: 'assistant' | 'owner';
      text: string;
      choices?: ChoiceView[];
      /** §22: this reply left a page the owner can take over in the app's `browser-live` view. */
      live?: LiveHandoff;
    } & EventMedia &
      RoomFields)
  | {
      type: 'delegation';
      seq: number;
      at: string;
      bot: { id: string; name: string };
      botChannel: string;
      task: string;
      state: 'started' | 'done' | 'failed';
      summary?: string;
    }
  | ({
      type: 'notice';
      seq: number;
      at: string;
      text: string;
      choices?: ChoiceView[];
      /** The notice kind ("browser.task", "dev.job"; "digest" and "overnight" for folded messages). */
      kind?: string;
      /** §22: a background task left a page the owner can take over in the `browser-live` view. */
      live?: LiveHandoff;
    } & EventMedia)
  | ({
      type: 'card';
      seq: number;
      at: string;
      cardId: string;
      summary: string;
      effects: Effect[];
      effectLabels: string[];
      note?: string;
      expiresAt: string;
      options: CardOptionView[];
      /** The owner may type another instruction instead (`card-reply`). */
      freeText: boolean;
      /** "From now on, just do it": wording and scope are the server's. */
      remember?: { label: string; detail?: string };
      /** R15: what is being decided; a newer card on an open topic reuses its cardId. */
      topic?: string;
    } & EventMedia)
  | {
      type: 'card_closed';
      seq: number;
      at: string;
      cardId: string;
      state: Exclude<CardState, 'open'>;
      /** The chosen option's label, or the owner's typed reply. */
      answer?: string;
    };

/** What callers append; the log assigns seq and at. */
export type AppEventDraft = AppEvent extends infer E ? (E extends AppEvent ? Omit<E, 'seq' | 'at'> : never) : never;

export const sendMessageSchema = z
  .object({
    text: z.string().max(8000).optional(),
    /** A choice button from an earlier message. */
    choice: z.string().min(1).max(100).optional(),
    /** Set by the share sheet: text or a link the owner passed to the assistant. */
    shared: z.boolean().optional(),
    /** Client-made id so a retried send is stored once. */
    clientId: z.string().min(1).max(160).optional(),
    /** A bot's room (R1); absent or "" = the main chat. */
    channel: z.preprocess((value) => (value === '' || value === null ? undefined : value), z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).optional()),
  })
  .refine((body) => (body.text !== undefined && body.text.trim() !== '') || body.choice !== undefined);

export const pushRegisterSchema = z.object({
  /** APNs device token, hex. */
  token: z.string().regex(/^[0-9A-Fa-f]{32,200}$/),
  environment: z.enum(['development', 'production']),
  /** The app's bundle id (the APNs topic). */
  topic: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/),
});

export const cardDecisionSchema = z.union([
  z.object({ decision: z.enum(['approve', 'deny', 'edit']) }),
  z.object({ option: z.string().min(1).max(100), remember: z.boolean().optional() }),
  z.object({ text: z.string().trim().min(1).max(2000) }),
]);
export type CardDecisionBody = z.infer<typeof cardDecisionSchema>;

export const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  /** Only this room's messages ("" = the main chat); other events are always included. */
  channel: z.string().max(31).optional(),
});
