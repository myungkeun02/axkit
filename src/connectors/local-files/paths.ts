import { isAbsolute, join, relative, sep } from 'node:path';
import { isInside } from './walk.js';

/** Expands a configured folder (`~`, `~/x`, absolute); undefined when it is not a usable path. */
export function expandFolder(path: string, home: string): string | undefined {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return isAbsolute(path) ? path : undefined;
}

/** Shortens a real path below home to "~/rel" for citations. */
export function displayPath(real: string, home: string): string {
  if (!isInside(home, real)) return real;
  const rel = relative(home, real);
  return rel === '' ? '~' : `~/${rel.split(sep).join('/')}`;
}
