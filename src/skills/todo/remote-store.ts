import type { TodoBackend, TodoItem } from '../../core/contracts/index.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { StoredTodo, TodoRepo } from './store.js';

/** What the outside list cannot hold: a due time of day and the reminder. Kept on this Mac by item id. */
interface LocalExtra {
  due?: string;
  remindAt?: string;
  reminded?: boolean;
}

const EXTRAS_KEY = 'remote-extras';
const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The to-do list kept in an outside service (Google Tasks). The skill reads a copy fetched with `sync`; every change
 * goes to the service first, so the owner sees it in the Tasks app too. Reminders stay local.
 */
export class RemoteTodoStore implements TodoRepo {
  private items: StoredTodo[] = [];
  private extras = new Map<string, LocalExtra>();
  private attemptedAt: number | undefined;

  constructor(
    private readonly backend: TodoBackend,
    private readonly kv: KeyValueStore,
    private readonly now: () => Date,
  ) {}

  /** Loads the local extras only; the list itself is fetched on first use, so start-up works offline. */
  async load(): Promise<void> {
    this.extras = new Map(Object.entries((await this.kv.get<Record<string, LocalExtra>>(EXTRAS_KEY)) ?? {}));
  }

  all(): readonly StoredTodo[] {
    return this.items;
  }

  get(id: string): StoredTodo | undefined {
    return this.items.find((item) => item.id === id);
  }

  async sync(maxAgeMs: number): Promise<void> {
    const now = this.now().getTime();
    // A failed fetch also counts, so an offline sweep does not retry every 30 seconds.
    if (this.attemptedAt !== undefined && now - this.attemptedAt < maxAgeMs) return;
    this.attemptedAt = now;
    const listed = await this.backend.list({ completedSince: new Date(now - DONE_WINDOW_MS) });
    this.items = listed.map((item) => this.merge(item));
  }

  async add(item: StoredTodo): Promise<StoredTodo> {
    const created = await this.backend.add({ text: item.text, ...(item.due !== undefined ? { due: item.due } : {}) });
    const extra: LocalExtra = {
      ...(item.due !== undefined && item.due.includes('T') ? { due: item.due } : {}),
      ...(item.remindAt !== undefined ? { remindAt: item.remindAt } : {}),
    };
    if (Object.keys(extra).length > 0) {
      this.extras.set(created.id, extra);
      await this.persist();
    }
    const stored = this.merge(created);
    this.items = [...this.items.filter((entry) => entry.id !== stored.id), stored];
    return stored;
  }

  async update(item: StoredTodo): Promise<void> {
    const previous = this.get(item.id);
    let next = item;
    if (item.done && previous?.done !== true) {
      const done = await this.backend.complete(item.id);
      next = { ...item, ...(done.completedAt !== undefined ? { completedAt: done.completedAt } : {}) };
    }
    if (next.done) {
      this.extras.delete(next.id);
    } else {
      const extra: LocalExtra = { ...this.extras.get(next.id) };
      if (next.remindAt !== undefined) extra.remindAt = next.remindAt;
      if (next.reminded !== undefined) extra.reminded = next.reminded;
      this.extras.set(next.id, extra);
    }
    await this.persist();
    this.items = this.items.map((entry) => (entry.id === next.id ? next : entry));
  }

  async remove(id: string): Promise<StoredTodo | undefined> {
    const previous = this.get(id);
    if (previous === undefined) return undefined;
    await this.backend.remove(id);
    this.items = this.items.filter((entry) => entry.id !== id);
    if (this.extras.delete(id)) await this.persist();
    return previous;
  }

  /** The service's item with the local due time (only while the date still matches) and reminder state. */
  private merge(item: TodoItem): StoredTodo {
    const extra = this.extras.get(item.id);
    if (extra === undefined) return item;
    const dueTime = extra.due !== undefined && item.due === extra.due.slice(0, 10) ? extra.due : undefined;
    return {
      ...item,
      ...(dueTime !== undefined ? { due: dueTime } : {}),
      ...(extra.remindAt !== undefined && !item.done ? { remindAt: extra.remindAt } : {}),
      ...(extra.reminded !== undefined ? { reminded: extra.reminded } : {}),
    };
  }

  private persist(): Promise<void> {
    return this.kv.set(EXTRAS_KEY, Object.fromEntries(this.extras));
  }
}
