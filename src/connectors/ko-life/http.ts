import type { ZodType } from 'zod';

const TIMEOUT_MS = 10_000;

/** Fetches JSON with a hard timeout. Errors never contain the URL, which can carry a key. */
export async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Korean public service request failed (HTTP ${response.status}).`);
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Korean public service returned an unreadable response.');
  }
}

/** Validates a response shape; the body is never echoed because it may contain personal data. */
export function parseShape<T>(schema: ZodType<T>, value: unknown, service: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${service} returned an unexpected response.`);
  return parsed.data;
}
