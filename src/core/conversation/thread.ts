import type { ConversationRef } from './types.js';

/** The owner's own thread: the app's main chat and the owner's Discord DM share it. */
export const OWNER_THREAD = 'owner';

/** Where owner-thread lines land when no channel is named (proactive notices). */
export const OWNER_THREAD_REF: ConversationRef = { channelId: 'channel.app', address: 'owner', thread: OWNER_THREAD };

/**
 * The memory thread of a conversation. The channel sets it; the app's main chat ("channel.app" / "owner") counts as the
 * owner's thread even when a line was built without it (browser hand-back, follow-up cards).
 */
export function threadOf(ref: ConversationRef): string | undefined {
  if (ref.thread !== undefined) return ref.thread;
  return ref.channelId === 'channel.app' && ref.address === 'owner' ? OWNER_THREAD : undefined;
}

/** One key per conversation: turns with the same key run one after another. */
export function conversationKey(ref: ConversationRef): string {
  const thread = threadOf(ref);
  return thread !== undefined ? `thread:${thread}` : `${ref.channelId}:${ref.address}`;
}
