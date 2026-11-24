const MASK = '[masked]';
const SECRET_KEY = /token|secret|password|api.?key|authorization/i;
const BEARER = /^bearer\s+\S+$/i;
const LONG_BLOB = /^[a-z0-9+/_=-]{32,}$/i;

function isSecretString(value: string): boolean {
  return BEARER.test(value) || LONG_BLOB.test(value);
}

/** Replaces values that look like credentials, recursively. Used by the logger and the audit log. */
export function sanitize(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>(), false);
}

export function sanitizeValue(value: unknown, seen: WeakSet<object>, keyMatched = false): unknown {
  if (keyMatched) return MASK;
  if (typeof value === 'string') return isSecretString(value) ? MASK : value;
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitizeValue(item, seen, SECRET_KEY.test(key));
  }
  return out;
}
