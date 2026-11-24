import { GoogleApiError } from './errors.js';
import type { GoogleTokenSource } from './token.js';
import { isRecord } from './json.js';
import { scopedSignal } from '../../core/tools/abort-scope.js';

const RETRY_DELAY_MS = 1000;

export interface GoogleRequestDeps {
  fetch: typeof fetch;
  tokens: Pick<GoogleTokenSource, 'accessToken' | 'invalidate'>;
  sleep: (ms: number) => Promise<void>;
}

export type GoogleRequestFn = <T>(url: string, init?: RequestInit) => Promise<T>;

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Google returned an unreadable response (HTTP ${response.status}).`);
  }
}

/** Google answers a call the sign-in has no scope for with 403 and ACCESS_TOKEN_SCOPE_INSUFFICIENT. */
function lacksScope(error: unknown, detail: string | undefined): boolean {
  if (detail !== undefined && /insufficient (authentication )?scopes?/i.test(detail)) return true;
  if (!isRecord(error) || !Array.isArray(error.details)) return false;
  return error.details.some((entry) => isRecord(entry) && entry.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
}

async function errorFor(response: Response): Promise<GoogleApiError> {
  const text = await response.text();
  let detail: string | undefined;
  let insufficientScope = false;
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body)) {
      const error = body.error;
      if (isRecord(error) && typeof error.message === 'string') detail = error.message;
      else if (typeof error === 'string') detail = error;
      else if (typeof body.error_description === 'string') detail = body.error_description;
      insufficientScope = response.status === 403 && lacksScope(error, detail);
    }
  } catch {
    // An HTML or empty error page has no safe detail to show.
  }
  const message = `Google API request failed (HTTP ${response.status})${detail === undefined ? '' : `: ${detail}`}`;
  return new GoogleApiError(message, response.status, insufficientScope);
}

/** Waits like `sleep`, but gives up as soon as the signal aborts. */
export async function sleepUnlessAborted(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return await sleep(ms);
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
  });
  aborted.catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The request's own signal, combined with the stop signal of the tool call it runs under (the executor's timeout),
 * so a timed-out tool's Google calls are cancelled too.
 */
export function withScopedSignal(init: RequestInit): RequestInit {
  const signal = scopedSignal(init.signal);
  return signal === undefined ? init : { ...init, signal };
}

/** Calls a Google API with the cached token, retrying once on 401 and on 429/5xx. */
export async function googleRequest<T>(deps: GoogleRequestDeps, url: string, given: RequestInit = {}): Promise<T> {
  const init = withScopedSignal(given);
  const signal = init.signal ?? undefined;
  let refreshed = false;
  let slept = false;

  for (;;) {
    const token = await deps.tokens.accessToken(signal);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await deps.fetch(url, { ...init, headers });

    if (response.status === 401 && !refreshed) {
      refreshed = true;
      deps.tokens.invalidate();
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && !slept) {
      slept = true;
      await sleepUnlessAborted(deps.sleep, RETRY_DELAY_MS, signal);
      continue;
    }
    if (!response.ok) throw await errorFor(response);
    return await readJson<T>(response);
  }
}
