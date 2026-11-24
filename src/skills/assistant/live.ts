import type { HandoffReason } from '../../core/contracts/index.js';
import type { LiveHandoff } from '../../core/conversation/types.js';

const REASONS: readonly HandoffReason[] = ['login', 'payment', 'consent', 'captcha', 'other'];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * A tool output that left a page the owner can take over says so with `liveView: "browser-live"` (with `url` and
 * `handoff.reason` when known); the browser skill's outputs follow this. The reply then carries it as a field, so
 * the app never has to find a phrase in the text.
 */
export function liveHandoffOf(output: unknown): LiveHandoff | undefined {
  const value = record(output);
  if (value?.liveView !== 'browser-live') return undefined;
  const raw = record(value.handoff)?.reason;
  const reason = REASONS.find((item) => item === raw) ?? 'other';
  const url = typeof value.url === 'string' && /^https?:\/\//i.test(value.url) ? value.url : undefined;
  return { view: 'browser-live', reason, ...(url !== undefined ? { url } : {}) };
}
