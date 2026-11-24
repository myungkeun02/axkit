import type { BrowserLiveHub, LiveState } from '../../core/contracts/index.js';
import type { Clock } from '../../core/scheduler/types.js';

/** How a page handed to the owner ended: they finished it, it went stale, or it was stopped (kill switch, shutdown). */
export type HandoffEnd = 'done' | 'expired' | 'cancelled';

/** The hub's own check runs every 30 s; an unopened handoff only expires when someone reads the state. */
const POLL_MS = 30_000;
/** Longer than a stale handoff (1 h) plus the longest live screen (1 h), in case the hub never settles. */
const MAX_WAIT_MS = 2 * 60 * 60_000 + 5 * 60_000;

function endOf(state: LiveState): HandoffEnd | undefined {
  if (state.live || state.pending !== undefined) return undefined;
  if (state.closed === 'done') return 'done';
  if (state.closed === 'stopped' || state.closed === 'shutdown') return 'cancelled';
  return 'expired';
}

/**
 * Resolves once the handoff the hub holds is over. While it waits, the caller keeps the browser lane, so the next
 * queued task cannot release the kept page (the half-filled form the owner is about to take over).
 */
export function handoffSettled(hub: BrowserLiveHub, clock: Clock, signal: AbortSignal): Promise<HandoffEnd> {
  return new Promise((resolve) => {
    let timer: unknown;
    const startedAt = clock.now().getTime();
    const finish = (end: HandoffEnd): void => {
      unsubscribe();
      if (timer !== undefined) clock.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(end);
    };
    const onAbort = (): void => finish('cancelled');
    const evaluate = (state: LiveState): boolean => {
      const end = endOf(state);
      if (end !== undefined) finish(end);
      return end !== undefined;
    };
    const poll = (): void => {
      timer = undefined;
      if (evaluate(hub.state())) return;
      if (clock.now().getTime() - startedAt >= MAX_WAIT_MS) return finish('expired');
      timer = clock.setTimeout(poll, POLL_MS);
    };
    const unsubscribe = hub.subscribe((state) => void evaluate(state));
    if (signal.aborted) return finish('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    poll();
  });
}
