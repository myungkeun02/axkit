import { basename, relative } from 'node:path';
import type { FileChange, FileEntry, FileSource, FileWatch } from '../../core/contracts/files.js';
import type { FileRules } from '../../core/files/filter.js';
import { fileVerdict } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import type { LocalFs } from './fs.js';
import { expandFolder } from './paths.js';
import { isInside, walkFolder } from './walk.js';
import type { WatchFactory, WatchRoot } from './watch.js';
import { nodeWatchFactory, watchFolders, watchablePath } from './watch.js';

export const WATCH_DEBOUNCE_MS = 3_000;
const WATCH_MAX_WAIT_MS = 30_000;
const WATCH_MAX_PATHS = 500;
const WATCH_MAX_FILES = 500;

export interface LocalFilesSourceOptions {
  fs: LocalFs;
  folders: readonly string[];
  rules: FileRules;
  includeHidden: boolean;
  home: string;
  log: Logger;
  /** Tests inject a deterministic watcher; production uses fs.watch. */
  watchFactory?: WatchFactory;
  debounceMs?: number;
}

type Root = WatchRoot;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function displayName(configured: string, real: string): string {
  const name = basename(configured);
  return name === '' || name === '.' || name === '..' ? basename(real) : name;
}

/** Read-only view over the folders the owner configured. No writes and no symlinks are followed. */
export class LocalFilesSource implements FileSource {
  readonly label = 'local';

  constructor(private readonly options: LocalFilesSourceOptions) {}

  private async roots(): Promise<Root[]> {
    return (await this.rootState()).roots;
  }

  /** Opened roots, plus the configured folders that could not be opened right now. */
  private async rootState(): Promise<{ roots: Root[]; missing: string[] }> {
    const roots: Root[] = [];
    const missing: string[] = [];
    for (const folder of this.options.folders) {
      const expanded = expandFolder(folder, this.options.home);
      if (expanded === undefined) {
        this.options.log.warn('local-files: a configured folder is not an absolute path');
        continue;
      }
      try {
        const real = await this.options.fs.realpath(expanded);
        roots.push({ real, name: displayName(expanded, real) });
      } catch (error) {
        missing.push(expanded);
        this.options.log.warn('local-files: a configured folder could not be opened', { error: messageOf(error) });
      }
    }
    return { roots, missing };
  }

  async list(opts: { modifiedAfter?: Date; limit: number; oldestFirst?: boolean }): Promise<FileEntry[]> {
    if (opts.limit <= 0) return [];
    const roots = await this.roots();
    const all: FileEntry[] = [];
    for (const root of roots) {
      all.push(
        ...(await walkFolder({
          fs: this.options.fs,
          root: root.real,
          rootName: root.name,
          rules: this.options.rules,
          includeHidden: this.options.includeHidden,
          modifiedAfter: opts.modifiedAfter,
          log: this.options.log,
        })),
      );
    }
    const direction = opts.oldestFirst === true ? -1 : 1;
    all.sort(
      (left, right) => direction * right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path),
    );
    return all.slice(0, opts.limit);
  }

  async entry(id: string): Promise<FileEntry | undefined> {
    const { roots, missing } = await this.rootState();
    const gone = (): undefined => {
      if (missing.some((folder) => isInside(folder, id))) throw new Error('The folder of this file is not reachable.');
      return undefined;
    };
    let info;
    try {
      info = await this.options.fs.lstat(id);
    } catch {
      return gone();
    }
    if (info.isSymbolicLink || !info.isFile) return undefined;
    let resolved: string;
    try {
      resolved = await this.options.fs.realpath(id);
    } catch {
      return gone();
    }
    const root = roots.find((candidate) => isInside(candidate.real, resolved));
    if (root === undefined) return gone();
    const rel = relative(root.real, resolved).split('\\').join('/');
    if (rel === '' || !watchablePath(rel, root.name, this.options.rules, this.options.includeHidden)) return undefined;
    const path = `${root.name}/${rel}`;
    if (fileVerdict(path, info.size, this.options.rules) !== 'ok') return undefined;
    return { id: resolved, name: basename(resolved), path, size: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() };
  }

  async watch(listener: (changes: readonly FileChange[]) => void | Promise<void>): Promise<FileWatch> {
    const roots = await this.roots();
    return watchFolders({
      roots,
      factory: this.options.watchFactory ?? nodeWatchFactory,
      debounceMs: this.options.debounceMs ?? WATCH_DEBOUNCE_MS,
      maxWaitMs: WATCH_MAX_WAIT_MS,
      maxPaths: WATCH_MAX_PATHS,
      rules: this.options.rules,
      includeHidden: this.options.includeHidden,
      resolve: (absolute, root) => this.changesAt(absolute, root),
      listener,
      log: this.options.log,
    });
  }

  /** A changed path: a file (its entry or that it went away) or a folder moved in (the files inside it). */
  private async changesAt(absolute: string, root: Root): Promise<FileChange[]> {
    let info;
    try {
      info = await this.options.fs.lstat(absolute);
    } catch {
      return [{ id: absolute }];
    }
    if (info.isSymbolicLink) return [];
    if (info.isDirectory) {
      const rel = relative(root.real, absolute).split('\\').join('/');
      const entries = await walkFolder({
        fs: this.options.fs,
        root: absolute,
        rootName: rel === '' ? root.name : `${root.name}/${rel}`,
        rules: this.options.rules,
        includeHidden: this.options.includeHidden,
        log: this.options.log,
      });
      return entries.slice(0, WATCH_MAX_FILES).map((entry) => ({ id: entry.id, entry }));
    }
    const entry = await this.entry(absolute);
    return [entry !== undefined ? { id: entry.id, entry } : { id: absolute }];
  }

  async readText(id: string, maxBytes: number): Promise<string> {
    const info = await this.options.fs.lstat(id);
    if (info.isSymbolicLink) throw new Error('Refusing to read a symlink.');
    if (!info.isFile) throw new Error('Not a regular file.');

    const resolved = await this.options.fs.realpath(id);
    const roots = await this.roots();
    const root = roots.find((candidate) => isInside(candidate.real, resolved));
    if (root === undefined) throw new Error('The file is outside the configured folders.');

    const rel = relative(root.real, resolved).split('\\').join('/');
    const displayPath = rel === '' ? root.name : `${root.name}/${rel}`;
    if (fileVerdict(displayPath, info.size, this.options.rules) !== 'ok') {
      throw new Error('The file is not allowed by the current file rules.');
    }

    const cap = Math.min(Math.max(0, maxBytes), this.options.rules.maxBytes);
    if (cap === 0) return '';
    const bytes = await this.options.fs.readFile(resolved);
    return Buffer.from(bytes).subarray(0, cap).toString('utf8');
  }
}
