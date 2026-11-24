import type { FileChange, FileChangeRecord, FileSource, FileWatch } from '../../core/contracts/files.js';
import { homeDisplay } from '../../core/files/home.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ChangeLog } from './changes.js';
import type { ChangeSink, SeenChange } from './index-job.js';
import { indexEntry, runFileIndex, sourcesOf } from './index-job.js';
import type { FileIndex } from './store.js';

export interface FileTrackerOptions {
  ctx: PluginContext;
  index: FileIndex;
  changes: ChangeLog;
  home: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Keeps the index current: live watching where a source can watch, the hourly poll always (a safety net for missed
 * events and for sources that cannot watch). Every index update goes through one queue, so the two never interleave.
 */
export class FileTracker implements ChangeSink {
  private queue: Promise<unknown> = Promise.resolve();
  private watches: FileWatch[] = [];
  private warned = false;

  constructor(private readonly options: FileTrackerOptions) {}

  /** True while at least one source is watched live. */
  get watching(): boolean {
    return this.watches.length > 0;
  }

  poll(): Promise<void> {
    return this.serial(() => runFileIndex(this.options.ctx, this.options.index, this));
  }

  async start(): Promise<void> {
    for (const source of sourcesOf(this.options.ctx)) {
      if (source.watch === undefined) continue;
      try {
        this.watches.push(
          await source.watch((changes) => {
            void this.serial(() => this.apply(source, changes)).catch((error: unknown) => {
              this.options.ctx.log.warn('files: changed files could not be indexed', { error: messageOf(error) });
            });
          }),
        );
      } catch (error) {
        if (this.warned) continue;
        this.warned = true;
        this.options.ctx.log.warn('files: folders cannot be watched; checking every hour instead', { error: messageOf(error) });
      }
    }
  }

  stop(): void {
    for (const watch of this.watches.splice(0)) watch.close();
  }

  async record(source: string, seen: readonly SeenChange[]): Promise<void> {
    if (seen.length === 0) return;
    const at = this.options.ctx.clock.now().toISOString();
    const records: FileChangeRecord[] = seen.map((change) => ({
      path: source === 'local' ? homeDisplay(change.id, this.options.home) : change.path,
      kind: change.kind,
      at,
    }));
    await this.options.changes.add(records);
    await this.options.ctx.bus.emit('files.changed', { source, changes: records });
  }

  /** Waits for queued index work (tests). */
  async idle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private async apply(source: FileSource, changes: readonly FileChange[]): Promise<void> {
    const { ctx, index } = this.options;
    const seen: SeenChange[] = [];
    for (const change of changes) {
      if (change.entry !== undefined) {
        const kind = await indexEntry(ctx, index, source, change.entry);
        if (kind !== undefined) seen.push({ id: change.entry.id, path: change.entry.path, kind });
        continue;
      }
      for (const gone of await index.removeUnder(source.label, change.id)) {
        seen.push({ id: gone.id, path: gone.id, kind: 'removed' });
      }
    }
    await index.save();
    await this.record(source.label, seen);
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
