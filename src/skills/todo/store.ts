import type { TodoItem } from '../../core/contracts/index.js';
import type { KeyValueStore } from '../../core/store/types.js';

export interface StoredTodo extends TodoItem {
  /** Set once a reminder was handed to the notifier, so it is not repeated. */
  reminded?: boolean;
  /** ISO date-time of the last change to the text, due date or done state; a two-way sync compares it. */
  updatedAt?: string;
}

const STORAGE_KEY = 'items';
const MAX_ITEMS = 1000;

/**
 * Where the to-do skill keeps items: its own key-value store, or an outside list (Google Tasks). Reads are
 * synchronous so approval cards can show an item's text; `sync` refreshes an outside list's copy first.
 */
export interface TodoRepo {
  all(): readonly StoredTodo[];
  get(id: string): StoredTodo | undefined;
  /** Resolves to the item as stored; an outside list gives it its own id. */
  add(item: StoredTodo): Promise<StoredTodo>;
  update(item: StoredTodo): Promise<void>;
  remove(id: string): Promise<StoredTodo | undefined>;
  /** Fetches the outside list again when the copy is older than `maxAgeMs`. The local store is always current. */
  sync(maxAgeMs: number): Promise<void>;
}

/**
 * Tiny repository over the plugin's key-value store. Reads are synchronous after `load()` so
 * approval cards can show an item's text without an extra async lookup.
 */
export class TodoStore implements TodoRepo {
  private items: StoredTodo[] = [];

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    this.items = [...((await this.kv.get<StoredTodo[]>(STORAGE_KEY)) ?? [])];
  }

  all(): readonly StoredTodo[] {
    return this.items;
  }

  get(id: string): StoredTodo | undefined {
    return this.items.find((item) => item.id === id);
  }

  async sync(): Promise<void> {
    // Nothing outside to fetch.
  }

  async add(item: StoredTodo): Promise<StoredTodo> {
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) {
      // Open items are never dropped: losing a to-do silently is worse than a long list.
      const oldestDone = this.items.findIndex((candidate) => candidate.done);
      if (oldestDone >= 0) this.items.splice(oldestDone, 1);
    }
    await this.persist();
    return item;
  }

  async update(item: StoredTodo): Promise<void> {
    const index = this.items.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) return;
    this.items[index] = item;
    await this.persist();
  }

  async remove(id: string): Promise<StoredTodo | undefined> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const [removed] = this.items.splice(index, 1);
    await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    return this.kv.set(STORAGE_KEY, this.items);
  }
}
