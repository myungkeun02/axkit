import type {
  BrowserAgent,
  BrowserLiveHub,
  HandoffReason,
  LiveBrowser,
  LiveCloseReason,
  LiveFrame,
  LiveInput,
  LiveState,
} from '../../core/contracts/index.js';
import type { ConversationRef } from '../../core/conversation/types.js';
import type { Logger } from '../../core/log/types.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { KillSwitch } from '../../core/switches/kill.js';

export const LIVE_IDLE_MS = 15 * 60_000;
/** Even a screen left open on the phone closes after this. */
export const LIVE_MAX_MS = 60 * 60_000;
/** A handoff the owner has not opened goes stale. */
export const PENDING_MS = 60 * 60_000;
const CHECK_MS = 30_000;
/** Inputs per second; a stuck finger or a looping client is dropped, not queued. */
const MAX_INPUTS_PER_SECOND = 8;
const MAX_TYPE_CHARS = 1000;
const MAX_SCROLL = 4000;

interface Session {
  live: LiveBrowser;
  reason: HandoffReason;
  origin?: ConversationRef;
  startedAt: number;
  lastActive: number;
  url: string;
  title: string;
  width: number;
  height: number;
}

export interface LiveHubDeps {
  agent: BrowserAgent;
  clock: Clock;
  log: Logger;
  killSwitch: () => KillSwitch | undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * The owner's live browser page (one at a time). It opens only for a handoff the browser skill recorded (`offer`)
 * and only when the owner's app asks; it closes on done, after 15 idle minutes, on the kill switch or at shutdown.
 * Typed text passes straight to the page: it is never logged, stored or shown to a model.
 */
export class LiveHub implements BrowserLiveHub {
  private pending: { url: string; reason: HandoffReason; at: number; origin?: ConversationRef } | undefined;
  private session: Session | undefined;
  private opening: Promise<boolean> | undefined;
  private closedReason: LiveCloseReason | undefined;
  private timer: unknown;
  private recent: number[] = [];
  private readonly listeners = new Set<(state: LiveState) => void>();

  constructor(private readonly deps: LiveHubDeps) {}

  /** Records a page the owner may take over: a handoff, or the owner's own request to see a page. */
  offer(url: string, reason: HandoffReason, origin?: ConversationRef): void {
    // only where to reply, never a message id to quote
    const from = origin === undefined ? undefined : { channelId: origin.channelId, address: origin.address };
    this.pending = { url, reason, at: this.now(), ...(from !== undefined ? { origin: from } : {}) };
    this.closedReason = undefined;
    // while it waits, the periodic check still frees a kept page when the kill switch goes on
    if (this.session === undefined) this.arm();
    this.notify();
  }

  state(): LiveState {
    if (this.pending !== undefined && this.now() - this.pending.at > PENDING_MS) this.pending = undefined;
    const session = this.session;
    const iso = (ms: number): string => new Date(ms).toISOString();
    if (session !== undefined) {
      const closesAt = Math.min(session.lastActive + LIVE_IDLE_MS, session.startedAt + LIVE_MAX_MS);
      return {
        live: true,
        url: session.url,
        title: session.title,
        reason: session.reason,
        startedAt: iso(session.startedAt),
        idleClosesAt: iso(closesAt),
      };
    }
    return {
      live: false,
      ...(this.pending !== undefined
        ? { pending: { url: this.pending.url, reason: this.pending.reason, at: iso(this.pending.at) } }
        : {}),
      ...(this.closedReason !== undefined ? { closed: this.closedReason } : {}),
    };
  }

  start(): Promise<boolean> {
    if (this.session !== undefined) return Promise.resolve(true);
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(): Promise<boolean> {
    const pending = this.state().pending;
    const origin = this.pending?.origin;
    const openLive = this.deps.agent.openLive;
    if (pending === undefined || openLive === undefined) return false;
    if (await this.stopped()) {
      await this.releaseKept();
      return false;
    }
    let live: LiveBrowser;
    try {
      live = await openLive.call(this.deps.agent, pending.url);
    } catch (error) {
      this.deps.log.warn('browser: live page could not open', { error: error instanceof Error ? error.name : 'error' });
      return false;
    }
    const now = this.now();
    this.session = {
      live,
      reason: pending.reason,
      ...(origin !== undefined ? { origin } : {}),
      startedAt: now,
      lastActive: now,
      url: pending.url,
      title: '',
      width: 0,
      height: 0,
    };
    this.closedReason = undefined;
    this.arm();
    this.notify();
    return true;
  }

  async frame(): Promise<LiveFrame | undefined> {
    const session = this.session;
    if (session === undefined) return undefined;
    session.lastActive = this.now();
    try {
      const frame = await session.live.frame();
      Object.assign(session, { url: frame.url, title: frame.title, width: frame.width, height: frame.height });
      return frame;
    } catch (error) {
      this.deps.log.warn('browser: live frame failed', { error: error instanceof Error ? error.name : 'error' });
      await this.close('error');
      return undefined;
    }
  }

  async input(action: LiveInput): Promise<'ok' | 'not_live' | 'too_fast'> {
    const session = this.session;
    if (session === undefined) return 'not_live';
    if (await this.stopped()) {
      await this.close('stopped');
      return 'not_live';
    }
    const now = this.now();
    this.recent = this.recent.filter((at) => now - at < 1000);
    if (this.recent.length >= MAX_INPUTS_PER_SECOND) return 'too_fast';
    this.recent.push(now);
    session.lastActive = now;
    const width = session.width > 0 ? session.width : Number.MAX_SAFE_INTEGER;
    const height = session.height > 0 ? session.height : Number.MAX_SAFE_INTEGER;
    try {
      switch (action.kind) {
        case 'tap':
          await session.live.tap(clamp(action.x, 0, width - 1), clamp(action.y, 0, height - 1));
          break;
        case 'type':
          await session.live.type(action.text.slice(0, MAX_TYPE_CHARS));
          break;
        case 'key':
          await session.live.key(action.key);
          break;
        case 'scroll':
          await session.live.scroll(clamp(action.dy, -MAX_SCROLL, MAX_SCROLL));
          break;
        case 'back':
          await session.live.back();
          break;
      }
    } catch (error) {
      // the error name only: a message could echo what was typed
      this.deps.log.warn('browser: live input failed', { kind: action.kind, error: error instanceof Error ? error.name : 'error' });
    }
    return 'ok';
  }

  async finish(): Promise<{ wasLive: boolean; host?: string; origin?: ConversationRef }> {
    const url = this.session?.url ?? this.pending?.url;
    const origin = this.session?.origin ?? this.pending?.origin;
    const wasLive = this.session !== undefined;
    this.pending = undefined;
    await this.close('done');
    // done without opening the screen: the page a handoff kept is not needed any more
    if (!wasLive) await this.releaseKept();
    const host = url === undefined ? undefined : hostOf(url);
    return { wasLive, ...(host !== undefined ? { host } : {}), ...(origin !== undefined ? { origin } : {}) };
  }

  subscribe(listener: (state: LiveState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Closes the page whatever state it is in (app shutdown). */
  async shutdown(): Promise<void> {
    await this.close('shutdown');
    await this.releaseKept();
  }

  /** The periodic check: kill switch, idle time and the hard cap. Public so tests can run it. */
  async check(): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      if (this.state().pending === undefined) return;
      if (await this.stopped()) {
        this.pending = undefined;
        this.closedReason = 'stopped';
        await this.releaseKept();
        this.notify();
      } else this.arm();
      return;
    }
    const now = this.now();
    if (await this.stopped()) await this.close('stopped');
    else if (now - session.lastActive >= LIVE_IDLE_MS || now - session.startedAt >= LIVE_MAX_MS) await this.close('idle');
    else this.arm();
  }

  private arm(): void {
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer);
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, CHECK_MS);
  }

  private async close(reason: LiveCloseReason): Promise<void> {
    const session = this.session;
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (session === undefined) {
      if (reason === 'done') {
        // the owner finished without opening the screen; whoever waits on the handoff learns it is over
        this.closedReason = 'done';
        this.notify();
      }
      return;
    }
    this.session = undefined;
    this.closedReason = reason;
    await session.live.close().catch(() => undefined);
    this.deps.log.info('browser: live page closed', { reason });
    this.notify();
  }

  private async releaseKept(): Promise<void> {
    await this.deps.agent.releaseKept?.().catch(() => undefined);
  }

  private async stopped(): Promise<boolean> {
    const kill = this.deps.killSwitch();
    if (kill === undefined) return false;
    try {
      return (await kill.state()).stopped;
    } catch {
      return true;
    }
  }

  private notify(): void {
    const state = this.state();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // a listener never breaks the hub
      }
    }
  }

  private now(): number {
    return this.deps.clock.now().getTime();
  }
}
