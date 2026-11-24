import type { ConversationRef, IncomingMessage } from '../conversation/types.js';
import type { DelegationEvent } from '../contracts/bots.js';
import type { KnowledgeLine } from '../contracts/knowledge.js';

/**
 * Event names and payloads. Plugins add their own events with declaration merging:
 *   declare module '<path>/core/events/types.js' { interface EventMap { 'mail.received': MailSummary } }
 */
export interface EventMap {
  'app.started': { at: Date };
  'app.stopping': { reason: string };
  'message.received': IncomingMessage;
  /**
   * The assistant is busy with an owner message: `thinking` when it starts, `working` with the tool it is running,
   * `idle` when it is done. Channels show a "typing" hint; nothing is stored.
   */
  'assistant.activity': { conversation: ConversationRef; state: 'thinking' | 'working' | 'idle'; tool?: string };
  /** The assistant handed a task to a bot, or the bot finished it. */
  'bots.delegation': DelegationEvent;
  /** A bot said something in its own room outside a reply (the result of a delegated task). */
  'bots.message': { bot: { id: string; name: string }; text: string; channel?: string; to?: { id: string; name: string } };
  /** The first-look scan (or a rescan) wrote what it found about the owner. */
  'knowledge.scanned': { profile: readonly KnowledgeLine[]; projects: readonly KnowledgeLine[] };
  /** A proactive notice (routine, mail, dev job…) actually reached the owner; the assistant keeps it in the owner thread. */
  'notice.delivered': { kind: string; text: string; at: string };
  /** The owner opened a lead meeting from the app (R17). */
  'bots.meeting_requested': { group: string; topic: string };
}

export type EventName = keyof EventMap;
export type EventHandler<K extends EventName> = (payload: EventMap[K]) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface EventBus {
  on<K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe;
  /** Runs every handler; one failing handler is logged and never stops the others. */
  emit<K extends EventName>(name: K, payload: EventMap[K]): Promise<void>;
}
