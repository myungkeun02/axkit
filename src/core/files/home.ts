import { isAbsolute, join, relative, sep } from 'node:path';
import { isSensitivePath } from './filter.js';

/**
 * Rules for paths anywhere under the owner's home (Spotlight results, a file sent to the app): app data under
 * ~/Library, hidden folders and files, and every name the folder rules treat as keys, passwords or ID documents are
 * never shown or opened.
 */
export function isExcludedHomePath(rel: string, extra: readonly string[] = []): boolean {
  const parts = rel.split(/[\\/]+/).filter((part) => part !== '');
  if (parts.length === 0) return true;
  if (parts.some((part) => part === '..')) return true;
  if ((parts[0] ?? '').toLowerCase() === 'library') return true;
  if (parts.some((part) => part.startsWith('.'))) return true;
  return isSensitivePath(parts.join('/'), extra);
}

/** "a/b" for a path below `home`; undefined for home itself or anything outside it. */
export function relativeToHome(path: string, home: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const rel = relative(home, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** "~/a/b" for a path below home; other paths come back unchanged. */
export function homeDisplay(path: string, home: string): string {
  const rel = relativeToHome(path, home);
  return rel === undefined ? path : `~/${rel}`;
}

/** `~`, `~/x` or an absolute path → absolute; undefined for anything else. */
export function expandHome(path: string, home: string): string | undefined {
  const trimmed = path.trim();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : undefined;
}
