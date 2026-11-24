/** A message as the transport saw it. `authorIsBot` is reported, not filtered, so the plugin owns that rule. */
export interface DiscordInbound {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  isDm: boolean;
  content: string;
  replyToId?: string;
  createdAt: Date;
}

export interface DiscordButtonPress {
  customId: string;
  userId: string;
  channelId: string;
  messageId: string;
  ack(): Promise<void>;
}

export type DiscordButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface DiscordOutbound {
  content: string;
  buttons?: { customId: string; label: string; style?: DiscordButtonStyle }[];
}

/**
 * Everything the Discord plugin needs from discord.js, behind one interface so tests use a fake
 * and the rest of the code never sees a vendor type.
 */
export interface DiscordPort {
  login(token: string): Promise<{ botUserId: string }>;
  onMessage(cb: (m: DiscordInbound) => void): void;
  onButton(cb: (b: DiscordButtonPress) => void): void;
  send(channelId: string, payload: DiscordOutbound): Promise<{ messageId: string }>;
  openDm(userId: string): Promise<string>;
  /** The latest messages of a channel, newest first; used after a restart to find what was missed. */
  recent?(channelId: string, limit: number): Promise<DiscordInbound[]>;
  /** Edits the card to `note` and removes its buttons (used once a confirmation is spent). */
  editComponentsOff(channelId: string, messageId: string, note: string): Promise<void>;
  destroy(): Promise<void>;
}
