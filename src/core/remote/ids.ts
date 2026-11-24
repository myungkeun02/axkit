/**
 * Ids and paths from another Mac. Everything a remote source returns is namespaced so it can never be mistaken for a
 * path on this Mac: ids look like "remote:MacBook:~/Documents/a.md" (or "remote:MacBook:/Volumes/x" outside home),
 * and citations look like "MacBook:~/Documents/a.md".
 */

export const REMOTE_PREFIX = 'remote:';

/** Letters, digits, "-" and "_"; at most 32. Compared without case (the Keychain name is lower-case). */
export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function isRemoteName(name: string): boolean {
  return REMOTE_NAME.test(name);
}

/** "Theo's MacBook Pro" → "Theos-MacBook-Pro"; "" when nothing usable is left. */
export function remoteNameFrom(label: string): string {
  const cleaned = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 32);
  return isRemoteName(cleaned) ? cleaned : '';
}

/** The Keychain entry holding the token for one paired Mac. */
export function remoteTokenSecret(name: string): string {
  return `remote-source.${name.toLowerCase()}.token`;
}

/** "remote:MacBook:" + a path as the other Mac wrote it ("~/x" or absolute). */
export function remoteId(name: string, path: string): string {
  return `${REMOTE_PREFIX}${name}:${path}`;
}

/** "remote:MacBook" alone means every folder the other Mac's owner shared. */
export function remoteAll(name: string): string {
  return `${REMOTE_PREFIX}${name}`;
}

export interface ParsedRemote {
  name: string;
  /** The path on the other Mac; undefined for "remote:MacBook" (all shared folders). */
  path?: string;
}

export function parseRemote(value: string): ParsedRemote | undefined {
  if (!value.startsWith(REMOTE_PREFIX)) return undefined;
  const rest = value.slice(REMOTE_PREFIX.length);
  const colon = rest.indexOf(':');
  const name = colon < 0 ? rest : rest.slice(0, colon);
  if (!isRemoteName(name)) return undefined;
  if (colon < 0) return { name };
  const path = rest.slice(colon + 1);
  if (path !== '~' && !path.startsWith('~/') && !path.startsWith('/')) return undefined;
  return { name, path };
}

/** "remote:MacBook:~/a" → "MacBook:~/a"; undefined for a path on this Mac. */
export function remoteDisplay(value: string): string | undefined {
  const parsed = parseRemote(value);
  if (parsed === undefined) return undefined;
  return parsed.path === undefined ? `${parsed.name}:~` : `${parsed.name}:${parsed.path}`;
}

/** The other Mac's home in the same namespace ("remote:MacBook:~"), for a remote value; undefined otherwise. */
export function remoteHomeOf(value: string): string | undefined {
  const parsed = parseRemote(value);
  return parsed === undefined ? undefined : remoteId(parsed.name, '~');
}
