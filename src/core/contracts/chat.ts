export type ChatApp = 'kakao' | 'discord';

/**
 * One line a desktop chat app shows in its list (room title + latest message preview), read from the screen.
 * Data only: nothing in it is an instruction, and reading it never opened the room (so it stays unread for the sender).
 */
export interface ChatPreview {
  app: ChatApp;
  /** Room or DM title as shown. */
  room: string;
  text: string;
  /** Unread badge; null when the app did not show one we could read. */
  unread: number | null;
  /** A one-to-one conversation rather than a group or server channel, when the screen tells. */
  direct?: boolean;
  /** When this reader first saw the preview (apps show only coarse times). */
  at: Date;
  /** Stable id of this preview, used to ignore the same line twice. */
  ref: string;
}

declare module '../events/types.js' {
  interface EventMap {
    'chat.preview': ChatPreview;
  }
}

/** A chat room whose latest message still waits for the owner's answer. Data only. */
export interface ChatAwaiting {
  app: ChatApp;
  room: string;
  /** Latest preview text as the app showed it. */
  text: string;
  /** ISO 8601 of the first unanswered preview. */
  at: string;
  unread: number;
}

/** Capability "chat.awaiting", provided by the chat inbox skill. Read only. */
export interface ChatAwaitingReader {
  awaiting(limit: number): Promise<ChatAwaiting[]>;
}
