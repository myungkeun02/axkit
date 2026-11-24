import { basename, join } from 'node:path';
import type { FolderWalk, ScannedFile, ScannedRepo } from '../../core/contracts/scan.js';
import type { FileRules } from '../../core/files/filter.js';
import { extensionOf, fileVerdict, isSensitivePath } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import type { LocalFs, LocalFsEntry } from './fs.js';
import { isInside } from './walk.js';

export const SKIP_DIRS = new Set([
  'node_modules',
  'library',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'pods',
  'deriveddata',
  '__pycache__',
  'venv',
  '.venv',
  'coverage',
  'tmp',
]);

export interface ScanRoot {
  real: string;
  display: string;
}

export interface ScanWalkOptions {
  fs: LocalFs;
  roots: readonly ScanRoot[];
  rules: FileRules;
  maxEntries: number;
  maxDepth: number;
  signal?: AbortSignal;
  log: Logger;
}

interface QueueItem extends ScanRoot {
  depth: number;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function abortError(): Error {
  const error = new Error('The scan was aborted.');
  error.name = 'AbortError';
  return error;
}

async function scanFile(
  options: ScanWalkOptions,
  root: string,
  candidate: string,
  display: string,
  name: string,
): Promise<ScannedFile | undefined> {
  let resolved: string;
  try {
    resolved = await options.fs.realpath(candidate);
  } catch (error) {
    options.log.warn('folder-scan: a file could not be resolved', { error: errorName(error) });
    return undefined;
  }
  if (!isInside(root, resolved)) return undefined;

  let info;
  try {
    info = await options.fs.stat(resolved);
  } catch (error) {
    options.log.warn('folder-scan: a file could not be read', { error: errorName(error) });
    return undefined;
  }
  if (!info.isFile) return undefined;

  return {
    id: resolved,
    path: display,
    name,
    ext: extensionOf(name),
    size: info.size,
    modifiedAt: new Date(info.mtimeMs).toISOString(),
    readable: fileVerdict(display, info.size, options.rules) === 'ok',
  };
}

async function repoModifiedAt(
  fs: LocalFs,
  dir: string,
  entries: readonly LocalFsEntry[],
  log: Logger,
): Promise<string> {
  let newest: number | undefined;
  for (const entry of entries) {
    // `.git` itself counts: each commit renames index.lock inside it, so its mtime moves with new work.
    if (entry.name.startsWith('.') && entry.name !== '.git') continue;
    try {
      const info = await fs.stat(join(dir, entry.name));
      if (newest === undefined || info.mtimeMs > newest) newest = info.mtimeMs;
    } catch (error) {
      log.warn('folder-scan: a repository entry could not be read', { error: errorName(error) });
    }
  }
  if (newest === undefined) {
    try {
      newest = (await fs.stat(dir)).mtimeMs;
    } catch (error) {
      log.warn('folder-scan: a repository could not be read', { error: errorName(error) });
    }
  }
  return new Date(newest ?? 0).toISOString();
}

/** Breadth-first scan over the owner's folders. Symlinks are never followed; repositories hide their contents. */
export async function scanWalk(options: ScanWalkOptions): Promise<FolderWalk> {
  const queue: QueueItem[] = options.roots.map((root) => ({ real: root.real, display: root.display, depth: 0 }));
  const files: ScannedFile[] = [];
  const repos: ScannedRepo[] = [];
  let visited = 0;
  let truncated = false;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (options.signal?.aborted === true) throw abortError();
    const current = queue[cursor];
    if (current === undefined) break;
    if (isSensitivePath(current.display, options.rules.exclude)) continue;

    let entries: LocalFsEntry[];
    try {
      entries = await options.fs.readdir(current.real);
    } catch (error) {
      options.log.warn('folder-scan: a folder could not be read', { error: errorName(error) });
      continue;
    }

    const dotGit = entries.find((entry) => entry.name === '.git');
    if (dotGit !== undefined) {
      repos.push({
        id: current.real,
        path: current.display,
        name: basename(current.real),
        modifiedAt: await repoModifiedAt(options.fs, current.real, entries, options.log),
      });
      continue;
    }

    for (const entry of entries) {
      if (visited >= options.maxEntries) {
        truncated = true;
        break;
      }
      visited += 1;
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink) continue;

      const display = `${current.display}/${entry.name}`;
      if (isSensitivePath(display, options.rules.exclude)) continue;
      const candidate = join(current.real, entry.name);

      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (current.depth + 1 <= options.maxDepth) {
          queue.push({ real: candidate, display, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile) continue;

      const file = await scanFile(options, current.real, candidate, display, entry.name);
      if (file !== undefined) files.push(file);
    }
    if (truncated) break;
  }

  files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path));
  repos.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path));
  return { files, repos, truncated };
}
