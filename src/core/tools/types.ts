import type { z } from 'zod';
import type { Effect } from '../policy/types.js';
import type { Logger } from '../log/types.js';
import type { AwaitOwner, ConversationRef, OutgoingImage } from '../conversation/types.js';
import type { AutonomyScope } from '../policy/autonomy.js';

/** What the caller knows about where a tool call came from. */
export interface ToolCallContext {
  /**
   * Texts this turn is grounded on: the owner's message, recent conversation, tool output read this turn.
   * Tools that turn words into actions (adding an event) must find their quoted evidence here.
   */
  grounding: readonly string[];
  /**
   * Only what the owner wrote (their message and earlier turns), without tool output: tools that keep the owner's
   * words as lasting memory or instructions check their evidence against this, never against mail or pages.
   */
  ownerGrounding?: readonly string[];
  /** The model's 육하원칙 line for the approval card (who asked, when, what, why). Shown, never trusted for policy. */
  why?: string;
  /** The conversation the request came from, when a conversation turn made the call (not jobs or app views). */
  conversation?: ConversationRef;
  /** The turn's way of waiting for the owner without holding the conversation (a confirmation card). */
  awaitOwner?: AwaitOwner;
  /** Runs work once this turn's reply is out (e.g. a background task's result never overtakes "시작했어요"). */
  afterTurn?: (work: () => Promise<void>) => void;
}

/** A capability the assistant (LLM) may call. Declared by plugins, executed only through ToolExecutor. */
export interface Tool<I = unknown, O = unknown> {
  /** Dotted, globally unique: "calendar.list_events". */
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** Lower bound. `effectsFor` may add effects from the real input (e.g. inviting guests adds `send`). */
  effects: readonly Effect[];
  effectsFor?(input: I): readonly Effect[];
  /**
   * Returns a reason when the input is not safe to act on as is: the call is refused and the model sees why.
   * Example: the quoted evidence is not in the conversation.
   */
  reject?(input: I, call: ToolCallContext): string | undefined;
  /**
   * Returns a reason when the input is a guess (ambiguous date, missing AM/PM). The executor then asks the owner
   * even for effects that normally run without asking, and shows the reason on the card.
   */
  uncertainty?(input: I, call: ToolCallContext): string | undefined;
  /**
   * What counts as "the same kind of action" if the owner says "from now on, just do it" on this card, in words the
   * owner reads (an amount cap, a recipient). Required for pay/delete tools to offer that at all; other tools get a
   * narrow default (exactly the same action again).
   */
  autonomyScope?(input: I): AutonomyScope | undefined;
  /** Exact text shown on the confirmation card. Required in spirit for any non-read tool. */
  describe?(input: I): string;
  /** Pictures that will be sent or posted (a poster, a photo), shown on the card where the channel can. */
  images?(input: I): readonly OutgoingImage[] | undefined;
  /** Run time limit for slow tools; the executor's default otherwise (capped at three hours). */
  timeoutMs?: number;
  run(input: I, ctx: ToolRunContext): Promise<O>;
}

export interface ToolRunContext {
  log: Logger;
  signal: AbortSignal;
  call: ToolCallContext;
}

export type ToolOutcome<O = unknown> =
  | { status: 'done'; output: O }
  | { status: 'invalid_input'; issues: string[] }
  | { status: 'rejected'; reason: string }
  | { status: 'denied' | 'expired' }
  | { status: 'failed'; error: string };

export interface ToolRegistry {
  register<I, O>(tool: Tool<I, O>): void;
  get(name: string): Tool<unknown, unknown> | undefined;
  list(): readonly Tool<unknown, unknown>[];
}

export interface ToolExecutor {
  /** Validates input, applies the confirmation policy, runs the tool and records an audit entry. */
  execute(name: string, rawInput: unknown, call?: ToolCallContext): Promise<ToolOutcome>;
}

/** What a model is told about a tool. */
export interface ToolInfo {
  name: string;
  description: string;
  effects: readonly Effect[];
  /** JSON Schema of the input. */
  inputSchema: Record<string, unknown>;
}

/** The assistant's view of tools: describe them to the model, run them through the policy. */
export interface Toolbox extends ToolExecutor {
  list(): readonly ToolInfo[];
}
