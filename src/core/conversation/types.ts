import type { HandoffReason } from '../contracts/browser.js';
import type { Effect } from '../policy/types.js';

/** Where a message came from and where a reply goes. Opaque to everything but the owning channel. */
export interface ConversationRef {
  channelId: string;
  /** Channel-specific address (Discord channel or DM id). */
  address: string;
  /** Message this one replies to, if any. */
  replyTo?: string;
  /**
   * The memory thread this conversation belongs to, set by the channel: "owner" for the owner's main chat in the app
   * and the owner's Discord DM, which share one memory (the channel only routes the reply). Unset for bot and team rooms.
   */
  thread?: string;
}

export interface IncomingMessage {
  id: string;
  conversation: ConversationRef;
  authorId: string;
  /**
   * Set by the channel from config, never from message content. Only owner messages may become instructions;
   * everything else (mail, web pages, other people, tool output) is data.
   */
  fromOwner: boolean;
  text: string;
  receivedAt: Date;
}

export interface Choice {
  id: string;
  label: string;
}

/** A picture sent with a message or a confirmation card: a local image file, or an https address. */
export type OutgoingImage = { path: string; name?: string } | { url: string };

export interface OutgoingMessage {
  text: string;
  /** Rendered as buttons where the channel supports them. The first choice is the assistant's best guess. */
  choices?: readonly Choice[];
  /** Shown where the channel can (the app); channels that cannot show pictures ignore them. */
  images?: readonly OutgoingImage[];
  /**
   * This turn left a page the owner can take over in an app view (docs/APP-PROTOCOL.md §22). The app shows its
   * "open the browser screen" button from this; channels without that view ignore it.
   */
  live?: LiveHandoff;
}

/** A page a tool left for the owner to finish themselves, in the app's `view`. */
export interface LiveHandoff {
  view: 'browser-live';
  reason: HandoffReason;
  url?: string;
}

/** Sends messages to the owner. Skills depend on this, not on a concrete channel. */
export interface Replier {
  reply(to: ConversationRef, message: OutgoingMessage): Promise<void>;
}

export type HandleResult = 'handled' | 'pass';

/** A tool a turn already ran, kept in the pending entry so a restart does not run it again blindly. */
export interface CompletedTool {
  name: string;
  effects: readonly Effect[];
  /** One short line of what it returned ("messageId: m-1"). */
  message: string;
  /** The call's arguments as stable JSON (capped), so a replayed turn can tell the same action from a new one. */
  args?: string;
}

/** An owner message of the same conversation that arrived and is not answered yet. */
export interface InProgressTurn {
  id: string;
  text: string;
  at: Date;
}

/** What the router hands a handler alongside the message. */
export interface TurnContext {
  /** Owner messages of this conversation queued or running right now, oldest first (this one included). */
  inProgress?: () => readonly InProgressTurn[];
  /** Called as each tool finishes, so a restart knows what already ran. */
  onToolDone?: (tool: CompletedTool) => void;
  /** Set on a turn replayed after a restart that had already run tools with effects. */
  resumed?: readonly CompletedTool[];
  /** While the turn waits for the owner (a confirmation card), the conversation is free: see {@link AwaitOwner}. */
  awaitOwner?: AwaitOwner;
  /** What this conversation is waiting for the owner to answer right now (open confirmation cards), oldest first. */
  awaiting?: () => readonly string[];
  /** Work for after the turn (compacting memory): runs once the reply is delivered or stored, outside the turn's slot. */
  afterTurn?: (work: () => Promise<void>) => void;
}

/**
 * Runs `wait` (a card waiting for the owner's answer) with the conversation's slot given up, so the owner's next
 * messages ("왜 필요한데?") are answered meanwhile; the turn takes its place back, ahead of newer messages, when `wait`
 * settles. `signal` is aborted when the owner cancels in chat ("취소해"): the card closes and counts as a no.
 */
/** `what`: the question the owner is asked (a card's summary), so other turns meanwhile know what is waiting. */
export type AwaitOwner = <T>(wait: (signal: AbortSignal) => Promise<T>, what?: string) => Promise<T>;

/** A skill's entry point for owner messages. The router tries handlers in priority order. */
export interface MessageHandler {
  id: string;
  /** Higher runs first. The general assistant (LLM) handler uses the lowest priority as the fallback. */
  priority: number;
  handle(message: IncomingMessage, replier: Replier, turn?: TurnContext): Promise<HandleResult>;
}
