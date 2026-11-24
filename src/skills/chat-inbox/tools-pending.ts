import { z } from 'zod';
import type { ChatApp } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import type { ChatInboxStore } from './store.js';

const pendingInput = z.object({});

export interface ChatPendingItem {
  room: string;
  app: ChatApp;
  /** ISO 8601 of the first preview that is still unanswered. */
  since: string;
  lastText: string;
}

export interface ChatPendingOutput {
  count: number;
  pending: ChatPendingItem[];
}

/** Tool "chat.pending": the rooms whose latest screen-read preview still waits for a reply. */
export function chatPendingTool(store: ChatInboxStore): Tool<z.infer<typeof pendingInput>, ChatPendingOutput> {
  return {
    name: 'chat.pending',
    description:
      'List chat rooms whose latest screen-read preview is still unanswered, oldest first. Read only: never opens or replies.',
    input: pendingInput,
    effects: ['read'],
    async run() {
      const pending = [...store.pendingEntries()]
        .sort((a, b) => a.firstAt.localeCompare(b.firstAt))
        .map((entry) => ({
          room: entry.room,
          app: entry.app,
          since: entry.firstAt,
          lastText: entry.lastText,
        }));
      return { count: pending.length, pending };
    },
  };
}
