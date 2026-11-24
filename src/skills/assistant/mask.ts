/** Anything this long that looks like a token or key is never written to the store. */
const SECRET_PATTERN = /[A-Za-z0-9_-]{24,}/g;

export function maskSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[가림]');
}
