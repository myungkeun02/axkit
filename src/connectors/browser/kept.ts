import type { LiveContext, LivePage } from './live.js';

/**
 * How long a handoff's page stays open for the owner's live view. After that the live view reloads the address
 * instead (the login is in the profile either way); the pending handoff itself lasts longer.
 */
export const KEEP_MS = 15 * 60_000;

export interface KeptPage {
  context: LiveContext;
  page: LivePage;
  /** The address the run stopped at; only a live view for this same address takes the page over. */
  url: string;
}

export interface KeptTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const NODE_TIMERS: KeptTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // a kept page never keeps the process alive
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * At most one run's page, held open after a handoff so the owner's live view continues it as it is. It holds the
 * persistent profile while kept: `onFree` runs once it is closed (timeout, kill switch, another run) and never when
 * the live view took it.
 */
export class KeptPages {
  private held: { kept: KeptPage; timer: unknown } | undefined;
  private freeing: Promise<void> | undefined;

  constructor(
    private readonly onFree: () => void,
    private readonly keepMs = KEEP_MS,
    private readonly timers: KeptTimers = NODE_TIMERS,
  ) {}

  hold(kept: KeptPage): void {
    // runs take turns, so an older kept page is already gone; never two contexts on one profile all the same
    const old = this.held;
    if (old !== undefined) {
      this.timers.clearTimeout(old.timer);
      void old.kept.context.close().catch(() => undefined);
    }
    const timer = this.timers.setTimeout(() => {
      void this.free();
    }, this.keepMs);
    this.held = { kept, timer };
  }

  /** The kept page for this address, handed over (no longer kept), or undefined. */
  take(url: string): KeptPage | undefined {
    const held = this.held;
    if (held === undefined || held.kept.url !== url || held.kept.page.isClosed?.() === true) return undefined;
    this.timers.clearTimeout(held.timer);
    this.held = undefined;
    return held.kept;
  }

  /** Closes the kept page, if any; resolves once the profile is free (also when another call is already closing it). */
  async free(): Promise<void> {
    const held = this.held;
    if (held === undefined) return await (this.freeing ?? Promise.resolve());
    this.held = undefined;
    this.timers.clearTimeout(held.timer);
    this.freeing = held.kept.context
      .close()
      .catch(() => undefined)
      .finally(() => {
        this.freeing = undefined;
        this.onFree();
      });
    await this.freeing;
  }
}
