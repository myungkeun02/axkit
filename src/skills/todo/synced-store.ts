import type { TodoSyncBackend } from '../../core/contracts/index.js';
import type { Logger } from '../../core/log/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { StoredTodo, TodoRepo, TodoStore } from './store.js';
import type { SyncReport, SyncState } from './sync.js';
import { EMPTY_SYNC_STATE, fingerprint, reconcile } from './sync.js';
import { newTodoId } from './tools-shared.js';

const STATE_KEY = 'sync-state';
const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A fresh read (todo.list) syncs at most this often; the periodic job does the rest. */
const FRESH_MIN_MS = 30_000;

export interface SyncedTodoStoreOptions {
  inner: TodoStore;
  backend: TodoSyncBackend;
  kv: KeyValueStore;
  now: () => Date;
  log: Logger;
  detachedNote: string;
}

/**
 * The local list kept in two-way sync with an outside list (Apple Reminders). The local copy is the one the skill
 * reads and writes, so the to-do tools keep working when the outside list cannot be reached; `syncNow` reconciles.
 */
export class SyncedTodoStore implements TodoRepo {
  private state: SyncState = EMPTY_SYNC_STATE;
  private running: Promise<SyncReport> | undefined;
  private lastAttempt: number | undefined;

  constructor(private readonly options: SyncedTodoStoreOptions) {}

  async load(): Promise<void> {
    await this.options.inner.load();
    this.state = (await this.options.kv.get<SyncState>(STATE_KEY)) ?? EMPTY_SYNC_STATE;
  }

  all(): readonly StoredTodo[] {
    return this.options.inner.all();
  }

  get(id: string): StoredTodo | undefined {
    return this.options.inner.get(id);
  }

  add(item: StoredTodo): Promise<StoredTodo> {
    return this.options.inner.add({ ...item, updatedAt: this.options.now().toISOString() });
  }

  async update(item: StoredTodo): Promise<void> {
    const previous = this.options.inner.get(item.id);
    // Only a change the other side can see counts as a change; a reminder being sent does not.
    const changed = previous === undefined || fingerprint(previous) !== fingerprint(item);
    const next: StoredTodo = changed ? { ...item, updatedAt: this.options.now().toISOString() } : item;
    await this.options.inner.update(next);
  }

  /** Deletes the local item only; the outside copy is left as it is (a sync never deletes there). */
  remove(id: string): Promise<StoredTodo | undefined> {
    return this.options.inner.remove(id);
  }

  /** `todo.list` asks for a fresh copy (0); the reminder sweep's older-copy refreshes are left to the periodic job. */
  async sync(maxAgeMs: number): Promise<void> {
    if (maxAgeMs !== 0) return;
    const now = this.options.now().getTime();
    if (this.lastAttempt !== undefined && now - this.lastAttempt < FRESH_MIN_MS) return;
    try {
      await this.syncNow();
    } catch (error) {
      this.options.log.warn('todo sync: could not reach the synced list; showing the local copy', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** One reconcile; concurrent callers share the run in progress. Throws when the outside list cannot be read. */
  syncNow(): Promise<SyncReport> {
    this.running ??= this.reconcileOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async reconcileOnce(): Promise<SyncReport> {
    const { backend, inner, kv, now } = this.options;
    const started = now();
    this.lastAttempt = started.getTime();
    const snapshot = [...inner.all()];
    const remotes = await backend.list({ completedSince: new Date(started.getTime() - DONE_WINDOW_MS) });
    const result = await reconcile({
      locals: snapshot,
      remotes,
      state: this.state,
      backend,
      now: started,
      newId: newTodoId,
      detachedNote: this.options.detachedNote,
    });
    const before = new Map(snapshot.map((item) => [item.id, fingerprint(item)]));
    for (const item of result.upserts) {
      const current = inner.get(item.id);
      if (current === undefined) {
        // Imported from outside, or deleted here while the sync ran (then it is not brought back).
        if (!before.has(item.id)) await inner.add(item);
        continue;
      }
      // Changed here while the sync ran: the newer local change wins and is pushed next time.
      if (fingerprint(current) !== before.get(item.id)) continue;
      await inner.update({ ...item, ...(current.reminded !== undefined ? { reminded: current.reminded } : {}) });
    }
    this.state = result.state;
    await kv.set(STATE_KEY, this.state);
    const { report } = result;
    const changed = report.pushed + report.pulled + report.created + report.imported + report.detached;
    if (changed > 0 || report.failed > 0) this.options.log.info('todo sync: reconciled', { label: backend.label, ...report });
    return report;
  }
}
