/**
 * Transient network failures (offline Mac, DNS, TLS handshake, 502/503/504) say nothing about a job. A job that fails
 * with one backs off exponentially from its own interval up to 30 minutes, with one warning when the streak starts and
 * one summary when it recovers, instead of an error line every tick. Ported from AX `resilience/backoff.ts`.
 */
const TRANSIENT_NET = new RegExp(
  [
    'TLS handshake timeout', 'handshake timed out', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
    'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT', 'Could not resolve host', 'i/o timeout',
    'Connection timed out', 'Operation timed out', 'Connection reset', 'connection refused', 'network is unreachable',
    'Failed to connect to', 'socket hang up', 'fetch failed', 'getaddrinfo', 'status 50[234]\\b', 'HTTP 50[234]\\b',
  ].join('|'),
  'i',
);

export function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error);
  return TRANSIENT_NET.test(message);
}

export interface NetStreak {
  failures: number;
  firstAt: number;
  nextAt: number;
  lastError: string;
}

export const MAX_BACKOFF_MS = 30 * 60_000;
const MIN_BACKOFF_MS = 60_000;

/** The wait before the next attempt after `failures` transient failures in a row. */
export function backoffMs(intervalMs: number, failures: number): number {
  const base = Math.max(MIN_BACKOFF_MS, intervalMs);
  return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(Math.max(0, failures - 1), 10));
}
