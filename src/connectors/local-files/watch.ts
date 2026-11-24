import { watch } from 'node:fs';
import { join } from 'node:path';
import type { FileChange, FileWatch } from '../../core/contracts/files.js';
import type { FileRules } from '../../core/files/filter.js';
import { isSensitivePath } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';

/** One recursive watch over a folder; `filename` is relative to it (absent when the OS could not say). */
export type WatchFactory = (
  dir: string,
  onEvent: (filename: string | undefined) => void,
  onError: (error: unknown) => void,
) => { close(): void };

/** `fs.watch(dir, {recursive: true})`: FSEvents on macOS. Never keeps the process alive by itself. */
export const nodeWatchFactory: WatchFactory = (dir, onEvent, onError) => {
  const watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
    onEvent(typeof filename === 'string' && filename !== '' ? filename : undefined);
  });
  watcher.on('error', onError);
  return {
    close: () => {
      watcher.close();
    },
  };
};

export interface WatchRoot {
  real: string;
  name: string;
}

export interface FolderWatchOptions {
  roots: readonly WatchRoot[];
  factory: WatchFactory;
  debounceMs: number;
  /** A folder that never goes quiet is still flushed this often. */
  maxWaitMs: number;
  /** Paths collected per flush; the rest wait for the hourly poll. */
  maxPaths: number;
  rules: FileRules;
  includeHidden: boolean;
  /** What a changed path means now: the files there, or that it is gone. */
  resolve: (absolute: string, root: WatchRoot) => Promise<FileChange[]>;
  listener: (changes: readonly FileChange[]) => void | Promise<void>;
  log: Logger;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** False for hidden names (unless allowed) and anything that looks like keys, passwords or ID documents. */
export function watchablePath(rel: string, rootName: string, rules: FileRules, includeHidden: boolean): boolean {
  const parts = rel.split(/[\\/]+/).filter((part) => part !== '');
  if (parts.length === 0 || parts.includes('..')) return false;
  if (!includeHidden && parts.some((part) => part.startsWith('.'))) return false;
  return !isSensitivePath(`${rootName}/${parts.join('/')}`, rules.exclude);
}

/** Debounced recursive watching: bursts of events become one list of changes per quiet period. */
export function watchFolders(options: FolderWatchOptions): FileWatch {
  const pending = new Map<string, WatchRoot>();
  const handles: { close(): void }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | undefined;
  let closed = false;
  let warned = false;
  let running: Promise<void> = Promise.resolve();

  const flush = async (): Promise<void> => {
    timer = undefined;
    firstAt = undefined;
    const batch = [...pending.entries()];
    pending.clear();
    const changes: FileChange[] = [];
    for (const [absolute, root] of batch) {
      try {
        changes.push(...(await options.resolve(absolute, root)));
      } catch (error) {
        options.log.warn('local-files: a changed path could not be checked', { error: errorName(error) });
      }
    }
    if (changes.length === 0 || closed) return;
    try {
      await options.listener(changes);
    } catch (error) {
      options.log.warn('local-files: a change listener failed', { error: errorName(error) });
    }
  };

  const schedule = (): void => {
    const now = Date.now();
    firstAt ??= now;
    if (timer !== undefined) clearTimeout(timer);
    const wait = Math.max(0, Math.min(options.debounceMs, firstAt + options.maxWaitMs - now));
    timer = setTimeout(() => {
      running = running.then(flush, flush);
    }, wait);
  };

  for (const root of options.roots) {
    try {
      handles.push(
        options.factory(
          root.real,
          (filename) => {
            if (closed || filename === undefined) return;
            if (!watchablePath(filename, root.name, options.rules, options.includeHidden)) return;
            if (pending.size >= options.maxPaths) return;
            pending.set(join(root.real, filename), root);
            schedule();
          },
          (error) => {
            if (warned) return;
            warned = true;
            options.log.warn('local-files: watching a folder failed; the hourly check still runs', { error: errorName(error) });
          },
        ),
      );
    } catch (error) {
      options.log.warn('local-files: a folder could not be watched', { error: errorName(error) });
    }
  }
  if (handles.length === 0) throw new Error('No configured folder could be watched.');

  return {
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const handle of handles.splice(0)) handle.close();
    },
  };
}
