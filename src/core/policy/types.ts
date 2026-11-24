import type { OutgoingImage } from '../conversation/types.js';
/**
 * What a tool does to the world. Confirmation is decided from effects by code, never by the model.
 * - read:   looks only (search mail, list events)
 * - write:  changes the owner's own data, reversible (add a to-do, create a private calendar event)
 * - send:   reaches another person or the public (send mail/message, post, invite, share)
 * - pay:    spends money or points, or commits to a purchase/booking
 * - delete: removes data that cannot be restored from inside ax-kit
 * - system: runs a command on this Mac (install, configure, restart); the card shows the exact command
 */
export type Effect = 'read' | 'write' | 'send' | 'pay' | 'delete' | 'system';

/** Effects that always need the owner's explicit approval. Config cannot turn these off. */
export const ALWAYS_CONFIRM: readonly Effect[] = ['send', 'pay', 'delete', 'system'];

export interface ConfirmPolicyConfig {
  /** Ask before `write` actions too (default false). */
  confirmWrites: boolean;
  /** Minutes until an unanswered confirmation expires (it is then treated as "no"). */
  expiresMinutes: number;
}

export interface ConfirmRequest {
  /** Exact, human-readable description of what will happen (recipient, text, amount...). */
  summary: string;
  effects: readonly Effect[];
  toolName: string;
  /** Why the owner is asked even though the effect alone would not need it (a guessed date, say). */
  note?: string;
  /**
   * Who asked, when, what and why, in one or two sentences (the model's words, screened for injections). Channels show
   * it before the question; `summary` stays the exact, code-made description of the action.
   */
  context?: string;
  /** What will be posted or sent, when it is a picture (the app shows it on the card; other channels ignore it). */
  images?: readonly OutgoingImage[];
  /**
   * Offered when this kind of action may run without a card next time. The wording and the scope are the server's;
   * a channel that lets the owner tick it calls `accept()` before answering 'approved'.
   */
  remember?: RememberOffer;
  /** A stable key of what is being decided (R15); the same topic is never asked twice. */
  topic?: string;
  /** The answers to show instead of yes / no. Each says what it means for the caller. */
  choices?: readonly ConfirmChoice[];
  /** A channel that shows `choices` or a reply box says which was used, before it answers. */
  report?: (answer: { choice?: string; text?: string }) => void;
}

export interface ConfirmChoice {
  id: string;
  label: string;
  tone?: 'primary' | 'danger' | 'neutral';
  detail?: string;
  /** approved = do it (this way), denied = don't, later = bring it back once at a later time. */
  means: 'approved' | 'denied' | 'later';
}

export interface RememberOffer {
  label: string;
  detail?: string;
  accept(): Promise<void>;
}

export type ConfirmAnswer = 'approved' | 'denied' | 'expired';

export interface ConfirmOptions {
  /**
   * Aborted when the same card was answered on another channel: the card closes and the promise resolves 'expired'
   * (the caller already has its answer and ignores it).
   */
  signal?: AbortSignal;
}

/** Implemented by a channel: shows a one-time approve/deny card bound to the owner. */
export interface Confirmer {
  confirm(request: ConfirmRequest, options?: ConfirmOptions): Promise<ConfirmAnswer>;
}
