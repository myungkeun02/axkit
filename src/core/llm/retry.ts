import type { LlmFailureKind } from './types.js';
import { LlmHttpError } from './providers/http-error.js';
import { isContentFault } from './fault.js';

export interface RetryPolicy {
  /** Extra attempts on the same route after a transient failure. */
  retries: number;
  /** A timed-out attempt already took a full deadline, so it is retried at most this often. */
  timeoutRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A Retry-After longer than this moves on to the next route instead of waiting. */
  maxRetryAfterMs: number;
  /** In [0, 1); jitter source. */
  random: () => number;
  /** Must reject when the signal aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: 2,
  timeoutRetries: 1,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 20_000,
  random: Math.random,
  sleep: abortableSleep,
};

const TIMEOUT = /timed? ?out|timeout|etimedout/i;
const TRANSIENT =
  /status (408|425|429|5\d\d)\b|overloaded|rate.?limit|too many requests|temporarily unavailable|econnreset|econnrefused|econnaborted|eai_again|epipe|socket hang up|fetch failed|network/i;
const AUTH = /status 40[13]\b|not logged in|unauthori[sz]ed|invalid api key|authentication/i;

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'TimeoutError' || TIMEOUT.test(message);
}

function statusKind(status: number): LlmFailureKind {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'transient';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 400) return 'request';
  return 'unknown';
}

/** Sorts a provider error into the kinds callers act on; a network-level TypeError counts as transient. */
export function failureKind(error: unknown): LlmFailureKind {
  if (error instanceof LlmHttpError) return statusKind(error.status);
  if (isTimeout(error)) return 'transient';
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  if (TRANSIENT.test(message) || TRANSIENT.test(cause)) return 'transient';
  if (AUTH.test(message)) return 'auth';
  if (isContentFault(error)) return 'request';
  return 'unknown';
}

export function statusOf(error: unknown): number | undefined {
  return error instanceof LlmHttpError ? error.status : undefined;
}

/**
 * How long to wait before attempt `retry` (1-based), or undefined to stop retrying this route.
 * Exponential backoff with jitter in [50%, 100%]; a Retry-After within the cap is honoured as the floor.
 */
export function retryDelay(policy: RetryPolicy, retry: number, error: unknown): number | undefined {
  if (failureKind(error) !== 'transient') return undefined;
  if (retry > policy.retries) return undefined;
  if (isTimeout(error) && retry > policy.timeoutRetries) return undefined;
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  const jittered = Math.round(backoff * (0.5 + policy.random() / 2));
  const retryAfter = error instanceof LlmHttpError ? error.retryAfterMs : undefined;
  if (retryAfter === undefined) return jittered;
  if (retryAfter > policy.maxRetryAfterMs) return undefined;
  return Math.max(jittered, retryAfter);
}

export type AttemptResult<T> = { ok: true; value: T; attempts: number } | { ok: false; error: unknown; attempts: number };

/**
 * Calls `work` until it succeeds or the failure is not worth retrying on the same route. A caller abort (during
 * the call or the wait) is rethrown, never reported as a failure.
 */
export async function withRetries<T>(
  work: () => Promise<T>,
  policy: RetryPolicy,
  signal: AbortSignal | undefined,
  onRetry?: (error: unknown, retry: number, delayMs: number) => void,
): Promise<AttemptResult<T>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ok: true, value: await work(), attempts: attempt };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      const delay = retryDelay(policy, attempt, error);
      if (delay === undefined) return { ok: false, error, attempts: attempt };
      onRetry?.(error, attempt, delay);
      await policy.sleep(delay, signal);
    }
  }
}
