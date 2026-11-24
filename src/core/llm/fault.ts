/**
 * Content failures say something about this request or its answer, not about the provider's health: a malformed or
 * empty answer, invalid JSON, or a 4xx other than auth/timeout/throttle. They still fall back to the next route, but
 * they never count toward a provider's circuit (otherwise one bad prompt could pause a healthy provider).
 */
const CONTENT_FAULT =
  /invalid JSON|malformed response|unexpected response|empty answer|structured output|schema|status 4(?!01|03|08|29)\d\d\b/i;

export function isContentFault(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CONTENT_FAULT.test(message);
}
