/** A provider's non-2xx answer. The message carries only the status, never the upstream body. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    /** From Retry-After, when the provider sent one. */
    readonly retryAfterMs: number | undefined,
  ) {
    super(`LLM request failed with status ${status}`);
    this.name = 'LlmHttpError';
  }
}

/** Retry-After is either delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Turns a failed response into an LlmHttpError, releasing the unread body. */
export async function httpError(response: Response): Promise<LlmHttpError> {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  await response.body?.cancel().catch(() => undefined);
  return new LlmHttpError(response.status, retryAfterMs);
}
