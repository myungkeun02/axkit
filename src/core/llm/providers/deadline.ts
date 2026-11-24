import type { Tier } from '../types.js';

/** One deadline for every tier, or one per tier (missing tiers keep the default). */
export type DeadlineConfig = number | Partial<Record<Tier, number>>;

/** Per attempt, covering the request and the body read. Deep work (planning, long answers) gets longer. */
export const HTTP_DEADLINES_MS: Readonly<Record<Tier, number>> = {
  cheap: 60_000,
  fast: 60_000,
  standard: 90_000,
  deep: 240_000,
};

export function deadlineFor(tier: Tier, config: DeadlineConfig | undefined, defaults: Readonly<Record<Tier, number>>): number {
  if (typeof config === 'number') return config;
  return config?.[tier] ?? defaults[tier];
}

/** Named TimeoutError so the usage ledger and the gateway's retry both read it as a timeout. */
export class LlmTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * Runs `work` with a signal that aborts after `ms` or when the caller's signal aborts, whichever is first, and
 * stops waiting at that moment even if `work` ignores its signal (a hung body read, a runner that never settles).
 */
export async function withDeadline<T>(
  ms: number,
  caller: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (caller?.aborted === true) throw abortReason(caller);
  const controller = new AbortController();
  let stop: (reason: unknown) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  stopped.catch(() => undefined);
  const timer = setTimeout(() => {
    const error = new LlmTimeoutError(ms);
    controller.abort(error);
    stop(error);
  }, ms);
  const onAbort = (): void => {
    const reason = caller === undefined ? undefined : abortReason(caller);
    controller.abort(reason);
    stop(reason);
  };
  caller?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', onAbort);
  }
}
