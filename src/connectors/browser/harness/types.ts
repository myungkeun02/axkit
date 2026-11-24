import { z } from 'zod';
import type { HandoffReason } from '../../../core/contracts/index.js';

/**
 * What the browser agent may do on a page. Every element action names a `ref` from the snapshot the model was shown;
 * anything else is refused before it reaches the browser. There is no free-form script, selector or coordinate.
 */
export const BrowserAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), ref: z.number().int().min(0).max(999) }),
  z.object({ kind: z.literal('fill'), ref: z.number().int().min(0).max(999), text: z.string().max(500) }),
  z.object({ kind: z.literal('select'), ref: z.number().int().min(0).max(999), option: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('press'), key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']) }),
  z.object({ kind: z.literal('scroll'), direction: z.enum(['down', 'up']) }),
  z.object({ kind: z.literal('navigate'), url: z.string().min(1).max(1000) }),
  z.object({ kind: z.literal('back') }),
  z.object({ kind: z.literal('wait'), seconds: z.number().int().min(1).max(10) }),
]);
export type BrowserAction = z.infer<typeof BrowserAction>;

/**
 * One model turn. `done` ends the run and must quote, verbatim, the page text that proves the result; code checks
 * the quote is really on the page. `handoff` stops for the owner (login, payment, consent, captcha, or a choice).
 */
export const Decision = z.object({
  thought: z.string().max(400),
  action: BrowserAction.nullable(),
  done: z.object({ answer: z.string().min(1).max(1500), evidence: z.string().min(1).max(300) }).nullable(),
  handoff: z
    .object({ reason: z.enum(['login', 'payment', 'consent', 'captcha', 'other']), note: z.string().max(300) })
    .nullable(),
});
export type Decision = z.infer<typeof Decision>;

export interface PageElement {
  ref: number;
  role: string;
  name: string;
  disabled: boolean;
  /** A password, card, CVC or ID-number field: never typed into by the agent. */
  secret: boolean;
  /** Which match of the same role + name this is, so the driver can pick the right one. */
  nth: number;
}

export interface Observation {
  url: string;
  title: string;
  /** Visible text of the page, already screened for instructions aimed at the AI. */
  text: string;
  elements: PageElement[];
}

export interface Driver {
  start(url: string): Promise<void>;
  observe(): Promise<Observation>;
  act(action: BrowserAction, element: PageElement | undefined): Promise<void>;
  close(): Promise<void>;
}

export type StopReason =
  | 'done'
  | 'handoff'
  | 'max_actions'
  | 'max_turns'
  | 'deadline'
  | 'stuck'
  | 'failed_actions'
  | 'rejected_actions'
  | 'model_failed'
  | 'cancelled'
  | 'out_of_scope';

/** One line of the run trace, kept for the owner, for replay and for evals. Holds no typed values. */
export interface TraceStep {
  turn: number;
  url: string;
  thought: string;
  action?: BrowserAction;
  outcome: 'acted' | 'rejected' | 'failed' | 'done' | 'handoff' | 'unverified_done';
  note?: string;
}

export interface HarnessResult {
  stop: StopReason;
  answer?: string;
  url: string;
  handoff?: { reason: HandoffReason; note: string; button?: string };
  actions: number;
  turns: number;
  trace: TraceStep[];
}

export interface HarnessLimits {
  maxActions: number;
  maxTurns: number;
  deadlineMs: number;
  /** A model call needs at least this much of the deadline left. */
  minModelMs: number;
  /** The same action on the same page this many times is a loop: the model is warned, then the run stops at twice. */
  repeatWarn: number;
  maxRejected: number;
  maxFailedInRow: number;
}

export const DEFAULT_LIMITS: HarnessLimits = {
  maxActions: 25,
  maxTurns: 45,
  deadlineMs: 10 * 60_000,
  minModelMs: 5_000,
  repeatWarn: 3,
  maxRejected: 6,
  maxFailedInRow: 3,
};
