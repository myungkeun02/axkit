import type { Logger } from '../../core/log/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { Watch } from './types.js';
import { MAX_WATCHES, watchSchema } from './types.js';

const KEY = 'watches';

/** Bounded repository over the plugin key-value store. */
export class WatchStore {
  private items: Watch[] = [];

  constructor(
    private readonly kv: KeyValueStore,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    const raw = await this.kv.get<unknown>(KEY);
    if (!Array.isArray(raw)) {
      this.items = [];
      return;
    }
    const parsed: Watch[] = [];
    for (const candidate of raw) {
      const result = watchSchema.safeParse(candidate);
      if (result.success) parsed.push(result.data);
      else this.log.warn('watch: dropping an unreadable entry');
    }
    this.items = parsed.slice(0, MAX_WATCHES);
  }

  all(): readonly Watch[] {
    return this.items;
  }

  get(id: string): Watch | undefined {
    return this.items.find((watch) => watch.id === id);
  }

  async add(watch: Watch): Promise<boolean> {
    if (this.items.length >= MAX_WATCHES) return false;
    this.items.push(watch);
    await this.persist();
    return true;
  }

  async update(watch: Watch): Promise<void> {
    const index = this.items.findIndex((candidate) => candidate.id === watch.id);
    if (index < 0) return;
    this.items[index] = watch;
    await this.persist();
  }

  async remove(id: string): Promise<Watch | undefined> {
    const index = this.items.findIndex((candidate) => candidate.id === id);
    if (index < 0) return undefined;
    const [removed] = this.items.splice(index, 1);
    await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    return this.kv.set(KEY, this.items);
  }
}
