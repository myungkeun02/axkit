import type { ConversationRef } from '../conversation/types.js';

/** Why a browser run stopped for a person: these steps are never done by the assistant. */
export type HandoffReason = 'login' | 'payment' | 'consent' | 'captcha' | 'other';

/** A one-time verification step the browser may complete on the owner's own task. */
export type AuthStep = { kind: 'code'; code: string } | { kind: 'link'; url: string };

/**
 * Given to a browser task only when the owner turned auto-auth on and the start site is on the allowed list. Asked when
 * a page wants a one-time code; undefined means the step goes to the owner. Codes are never logged or shown to a model.
 */
export interface BrowserAuthHelper {
  stepFor(pageUrl: string, pageText: string, signal?: AbortSignal): Promise<AuthStep | undefined>;
}

export interface BrowserTask {
  /** What to do, in the owner's words. */
  goal: string;
  startUrl?: string;
  /** Present only on owner-started tasks for allowed sites; adapters that cannot type ignore it. */
  auth?: BrowserAuthHelper;
  /**
   * The one final button (a booking, a submit) the owner approved on this run's card, exactly as a previous run
   * reported it. Never a payment button: those stay the owner's whatever this says.
   */
  approvedCommit?: string;
  /**
   * On a handoff, keep the run's page open for a while so the owner's live view (`openLive`) takes over that exact
   * page, half-filled forms included, instead of reloading the address. Adapters without a live view ignore it.
   */
  keepPage?: boolean;
}

export interface BrowserRunResult {
  status: 'done' | 'needs_human' | 'failed';
  /** What the run found or did. Page-derived text: data, never instructions. */
  summary: string;
  url?: string;
  /** `button`: the final button the run stopped before, so the owner can approve exactly that one. */
  handoff?: { reason: HandoffReason; url?: string; button?: string };
}

/** Capability "browser.agent": a browser the owner set up on this Mac, driven by an adapter. */
export interface BrowserAgent {
  readonly label: string;
  /** Opens one page and returns its visible text, without clicking or typing. */
  read(url: string, signal?: AbortSignal): Promise<BrowserRunResult>;
  /** Hands a multi-step task to the adapter; it must stop at logins, payments and consent screens. */
  run(task: BrowserTask, signal?: AbortSignal): Promise<BrowserRunResult>;
  /** Shows the page on this Mac's screen in the same browser profile, so the owner can log in or pay themselves. */
  openForHuman?(url: string): Promise<void>;
  /**
   * A page the owner drives from the phone app (tap, type, scroll) in the same persistent profile, so a login carries
   * over to the next run. Only one can be open, and never while a run or the Mac window holds the profile. The
   * assistant never drives it: only the owner's app does, through the "browser.live" hub. When a handoff kept the
   * run's page (`keepPage`) for this same address, that page is taken over as it is; otherwise the address reloads.
   */
  openLive?(url: string): Promise<LiveBrowser>;
  /** Closes a page a handoff kept for `openLive` (if any), freeing the profile. Safe to call any time. */
  releaseKept?(): Promise<void>;
}

/** One screenshot of the live page. `width`/`height` are the JPEG's pixels; taps use the same pixels. */
export interface LiveFrame {
  jpeg: Buffer;
  width: number;
  height: number;
  url: string;
  title: string;
}

export const LIVE_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
export type LiveKey = (typeof LIVE_KEYS)[number];

export interface LiveBrowser {
  frame(): Promise<LiveFrame>;
  /** Frame pixels, top-left origin. */
  tap(x: number, y: number): Promise<void>;
  /** Typed into whatever has focus. The text is the owner's (often a password): never logged or kept. */
  type(text: string): Promise<void>;
  key(name: LiveKey): Promise<void>;
  /** Frame pixels; positive scrolls down. */
  scroll(dy: number): Promise<void>;
  back(): Promise<void>;
  /** Frees the profile for the next run. Safe to call twice. */
  close(): Promise<void>;
}

/** One thing the owner did on the live page. */
export type LiveInput =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: LiveKey }
  | { kind: 'scroll'; dy: number }
  | { kind: 'back' };

export type LiveCloseReason = 'done' | 'idle' | 'stopped' | 'error' | 'shutdown';

/** Where the live page stands, as the app shows it. Never holds typed text. */
export interface LiveState {
  live: boolean;
  url?: string;
  title?: string;
  /** Why the errand stopped for the owner. */
  reason?: HandoffReason;
  startedAt?: string;
  /** When it closes by itself if nothing happens. */
  idleClosesAt?: string;
  /** A handoff waiting for the owner to open it (`start`). */
  pending?: { url: string; reason: HandoffReason; at: string };
  /** Why the last session ended, until the next one starts. */
  closed?: LiveCloseReason;
}

/**
 * Capability "browser.live", provided by skill.browser when the adapter can open a live page. The app channel serves
 * it to the owner's own app; sessions start only from a handoff or the owner's own request, never from page content.
 */
export interface BrowserLiveHub {
  state(): LiveState;
  /** Records a page the owner may take over, and the conversation the errand came from (for `finish`). */
  offer(url: string, reason: HandoffReason, origin?: ConversationRef): void;
  /** Opens the pending handoff page; false when nothing is pending or the profile is busy. */
  start(): Promise<boolean>;
  /** The current frame, or undefined when nothing is open. */
  frame(): Promise<LiveFrame | undefined>;
  /** `not_live`: nothing is open; `too_fast`: over the input rate, dropped. Coordinates are clamped to the frame. */
  input(action: LiveInput): Promise<'ok' | 'not_live' | 'too_fast'>;
  /**
   * The owner finished: closes the page and clears the handoff. Returns the host the owner was on, and the
   * conversation the errand came from, if known.
   */
  finish(): Promise<{ wasLive: boolean; host?: string; origin?: ConversationRef }>;
  /** Called on every state change (opened, closed). */
  subscribe(listener: (state: LiveState) => void): () => void;
}
