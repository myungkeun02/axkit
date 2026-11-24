import { join, sep } from 'node:path';
import type { FileEntry } from '../../core/contracts/files.js';
import type { FileRules } from '../../core/files/filter.js';
import { fileVerdict } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import type { LocalFs } from './fs.js';

export const MAX_DEPTH = 6;
export const MAX_ENTRIES_PER_FOLDER = 5_000;

interface QueueItem {
  dir: string;
  rel: string;
  depth: number;
}

interface Found {
  entry: FileEntry;
  mtimeMs: number;
}

export interface WalkOptions {
  fs: LocalFs;
  root: string;
  rootName: string;
  rules: FileRules;
  includeHidden: boolean;
  modifiedAfter?: Date | undefined;
  log: Logger;
}

/** True when `candidate` is the same path as `root` or sits below it. */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Walks one folder without following symlinks, returning eligible files newest first. */
export async function walkFolder(options: WalkOptions): Promise<FileEntry[]> {
  const queue: QueueItem[] = [{ dir: options.root, rel: '', depth: 0 }];
  const found: Found[] = [];
  let visited = 0;

  for (let cursor = 0; cursor < queue.length && visited < MAX_ENTRIES_PER_FOLDER; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) break;
    let entries;
    try {
      entries = await options.fs.readdir(current.dir);
    } catch (error) {
      options.log.warn('local-files: a folder could not be read', { error: messageOf(error) });
      continue;
    }

    for (const entry of entries) {
      if (visited >= MAX_ENTRIES_PER_FOLDER) break;
      visited += 1;
      if (!options.includeHidden && entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink) continue;

      const absolute = join(current.dir, entry.name);
      const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`;
      if (entry.isDirectory) {
        if (current.depth + 1 <= MAX_DEPTH) {
          queue.push({ dir: absolute, rel, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile) continue;

      let resolved: string;
      try {
        resolved = await options.fs.realpath(absolute);
      } catch (error) {
        options.log.warn('local-files: a file could not be resolved', { error: messageOf(error) });
        continue;
      }
      if (!isInside(options.root, resolved)) continue;

      let info;
      try {
        info = await options.fs.stat(resolved);
      } catch (error) {
        options.log.warn('local-files: a file could not be read', { error: messageOf(error) });
        continue;
      }
      if (!info.isFile) continue;

      const displayPath = `${options.rootName}/${rel}`;
      if (fileVerdict(displayPath, info.size, options.rules) !== 'ok') continue;
      if (options.modifiedAfter !== undefined && info.mtimeMs <= options.modifiedAfter.getTime()) continue;

      found.push({
        mtimeMs: info.mtimeMs,
        entry: {
          id: resolved,
          name: entry.name,
          path: displayPath,
          size: info.size,
          modifiedAt: new Date(info.mtimeMs).toISOString(),
        },
      });
    }
  }

  found.sort((left, right) => right.mtimeMs - left.mtimeMs || left.entry.path.localeCompare(right.entry.path));
  return found.map((item) => item.entry);
}
