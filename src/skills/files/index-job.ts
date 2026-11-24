import type { FileChangeKind, FileEntry, FileSource } from '../../core/contracts/files.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { chunkText } from './chunk.js';
import type { RetryEntry } from './retry.js';
import { MAX_READ_TRIES, loadRetries, saveRetries } from './retry.js';
import { sourcesOf } from './sources.js';
import type { FileIndex } from './store.js';

export { sourcesOf } from './sources.js';

export const INDEX_JOB = 'files.index';
export const LIST_LIMIT = 200;
/** Batches per run: a burst bigger than this finishes on the next run, from where this one stopped. */
const MAX_BATCHES = 10;
const MAX_TIED_LIMIT = 5_000;
const READ_BYTES = 200_000;

/** A change the index saw, before it becomes a change-log line. */
export interface SeenChange {
  id: string;
  /** The source's display path, used when the id is not a path under home (Drive). */
  path: string;
  kind: FileChangeKind;
}

/** Where index changes are reported (the change log and the `files.changed` event). */
export interface ChangeSink {
  record(source: string, changes: readonly SeenChange[]): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Reads and stores one file unless the index already has this version. Answers what happened to it. */
export async function indexEntry(
  ctx: PluginContext,
  index: FileIndex,
  source: FileSource,
  entry: FileEntry,
): Promise<FileChangeKind | undefined> {
  const result = await tryIndexEntry(ctx, index, source, entry);
  return result === 'failed' ? undefined : result;
}

/** Like `indexEntry`, but says `failed` when the file could not be read, so the caller can keep it for a retry. */
async function tryIndexEntry(
  ctx: PluginContext,
  index: FileIndex,
  source: FileSource,
  entry: FileEntry,
): Promise<FileChangeKind | 'failed' | undefined> {
  const existing = await index.get(source.label, entry.id);
  if (existing !== undefined && existing.modifiedAt === entry.modifiedAt && existing.chunks.length > 0) return undefined;

  let text: string;
  try {
    text = await source.readText(entry.id, READ_BYTES);
  } catch (error) {
    ctx.log.warn('files: a file could not be read', { source: source.label, error: messageOf(error) });
    return 'failed';
  }
  await index.put({
    source: source.label,
    id: entry.id,
    name: entry.name,
    path: entry.path,
    modifiedAt: entry.modifiedAt,
    chunks: chunkText(text),
  });
  return existing !== undefined ? 'changed' : 'added';
}

/**
 * The next cursor after a batch: just before its newest file when the batch was full, so ties are listed again. It
 * stays at `previous` when a full batch is all one modified time (the caller then lists a bigger batch).
 */
function nextCursor(newest: number, full: boolean, previous: number | undefined): number | undefined {
  if (!full) return newest;
  const before = newest - 1;
  return previous !== undefined && before <= previous ? previous : before;
}

async function indexChanged(
  ctx: PluginContext,
  index: FileIndex,
  source: FileSource,
  seen: SeenChange[],
  failed: Map<string, RetryEntry>,
): Promise<boolean> {
  const first = await index.cursor(source.label);
  let cursor = first?.getTime();
  let limit = LIST_LIMIT;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const entries = await source.list({
      ...(cursor !== undefined ? { modifiedAfter: new Date(cursor) } : {}),
      limit,
      oldestFirst: true,
    });
    let newest = 0;
    for (const entry of entries) {
      const modified = Date.parse(entry.modifiedAt);
      if (Number.isFinite(modified) && modified > newest) newest = modified;
      const kind = await tryIndexEntry(ctx, index, source, entry);
      if (kind === 'failed') failed.set(entry.id, { entry, tries: (failed.get(entry.id)?.tries ?? 0) + 1 });
      else {
        failed.delete(entry.id);
        if (kind !== undefined) seen.push({ id: entry.id, path: entry.path, kind });
      }
    }
    await index.save();
    if (newest <= 0) break;
    const full = entries.length >= limit;
    const next = nextCursor(newest, full, cursor);
    if (next !== undefined) await index.setCursor(source.label, new Date(next).toISOString());
    if (!full) break;
    if (next === cursor) {
      // more files share one modified time than a batch holds: list a bigger batch instead of stalling
      if (limit >= MAX_TIED_LIMIT) break;
      limit = Math.min(limit * 5, MAX_TIED_LIMIT);
      continue;
    }
    cursor = next;
  }
  return first !== undefined;
}

/** Docs whose file is gone (or no longer allowed) leave the index; a folder that cannot be reached keeps its docs. */
async function sweepRemoved(ctx: PluginContext, index: FileIndex, source: FileSource, seen: SeenChange[]): Promise<void> {
  const check = source.entry?.bind(source);
  if (check === undefined) return;
  for (const doc of await index.docs(source.label)) {
    let current: FileEntry | undefined;
    try {
      current = await check(doc.id);
    } catch {
      continue;
    }
    if (current !== undefined) continue;
    const stored = await index.get(source.label, doc.id);
    for (const gone of await index.removeUnder(source.label, doc.id)) {
      seen.push({ id: gone.id, path: stored?.path ?? gone.id, kind: 'removed' });
    }
  }
  await index.save();
}

/** Files whose read failed earlier are read again first; what fails again stays (up to MAX_READ_TRIES). */
async function retryFailed(ctx: PluginContext, index: FileIndex, source: FileSource, seen: SeenChange[]): Promise<Map<string, RetryEntry>> {
  const failed = new Map<string, RetryEntry>();
  for (const retry of await loadRetries(ctx.kv, source.label)) {
    const kind = await tryIndexEntry(ctx, index, source, retry.entry);
    if (kind === 'failed') {
      if (retry.tries + 1 < MAX_READ_TRIES) failed.set(retry.entry.id, { entry: retry.entry, tries: retry.tries + 1 });
      else ctx.log.warn('files: giving up on a file that keeps failing to read', { source: source.label });
    } else if (kind !== undefined) seen.push({ id: retry.entry.id, path: retry.entry.path, kind });
  }
  await index.save();
  return failed;
}

async function indexSource(ctx: PluginContext, index: FileIndex, source: FileSource, sink?: ChangeSink): Promise<void> {
  const seen: SeenChange[] = [];
  const failed = await retryFailed(ctx, index, source, seen);
  // the very first run fills the index; it is not a change worth logging
  let hadCursor: boolean;
  try {
    hadCursor = await indexChanged(ctx, index, source, seen, failed);
  } finally {
    await saveRetries(ctx.kv, source.label, [...failed.values()]);
  }
  const changes = hadCursor ? seen : [];
  await sweepRemoved(ctx, index, source, changes);
  if (changes.length > 0) await sink?.record(source.label, changes);
}

/** Re-scans every connected file source, oldest unseen changes first, and updates the token index. */
export async function runFileIndex(ctx: PluginContext, index: FileIndex, sink?: ChangeSink): Promise<void> {
  const sources = sourcesOf(ctx);
  if (sources.length === 0) {
    ctx.log.debug('files: no file source is connected');
    return;
  }
  for (const source of sources) {
    try {
      await indexSource(ctx, index, source, sink);
    } catch (error) {
      ctx.log.warn('files: a file source could not be listed', { source: source.label, error: messageOf(error) });
    }
  }
}

export function registerFileIndex(ctx: PluginContext, seconds: number, run: () => Promise<void>): void {
  ctx.scheduler.add({
    name: INDEX_JOB,
    schedule: { kind: 'every', seconds },
    run,
  });
}
