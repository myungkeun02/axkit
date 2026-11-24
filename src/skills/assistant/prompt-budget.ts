import type { IncomingMessage } from '../../core/conversation/types.js';

/** Sections in order of importance, each cut to `each` characters and dropped once `total` is reached. */
export function withinBudget(parts: readonly (string | undefined)[], total = 10_000, each = 3_000): string {
  const out: string[] = [];
  let used = 0;
  for (const part of parts) {
    if (part === undefined || part.trim() === '') continue;
    const cut = part.length > each ? `${part.slice(0, each)}\n…` : part;
    if (used + cut.length > total) break;
    out.push(cut);
    used += cut.length + 2;
  }
  return out.join('\n\n');
}

export const ownChat = (message: IncomingMessage): boolean => message.conversation.channelId.startsWith('channel.');
