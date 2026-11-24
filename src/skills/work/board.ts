import { z } from 'zod';
import type { WorkInProgress, WorkItem } from '../../core/contracts/index.js';
import { isActiveWork } from '../../core/contracts/index.js';
import type { KeyValueStore } from '../../core/store/types.js';

const KEY = 'items';
const MAX_ITEMS = 60;
/** A stop for the owner that nobody picked up in a day is history, not work in progress. */
const WAITING_STALE_MS = 24 * 3_600_000;

const itemSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.string().min(1).max(60),
  title: z.string().max(300),
  status: z.enum(['queued', 'running', 'waiting', 'done', 'failed', 'interrupted']),
  phase: z.string().max(120).optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  origin: z.object({ channelId: z.string(), address: z.string(), replyTo: z.string().optional() }).optional(),
  summary: z.string().max(2000).optional(),
  link: z.string().max(2048).optional(),
  parent: z.string().max(200).optional(),
});

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The owner's work list, kept in the store so "최근에 끝난 일" survives a restart. */
export class KvWorkBoard implements WorkInProgress {
  private items: WorkItem[] = [];

  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date,
  ) {}

  /**
   * Anything still running when the server stopped did not finish. Producers that are alive update their own items
   * again; this covers the ones that never come back.
   */
  async load(): Promise<void> {
    const raw = await this.kv.get<unknown>(KEY);
    const parsed = Array.isArray(raw)
      ? raw.flatMap((entry) => {
          const result = itemSchema.safeParse(entry);
          return result.success ? [result.data as WorkItem] : [];
        })
      : [];
    const at = this.now().toISOString();
    this.items = parsed.slice(0, MAX_ITEMS).map((item) =>
      item.status === 'running' || item.status === 'queued' ? { ...item, status: 'interrupted', updatedAt: at } : item,
    );
    await this.kv.set(KEY, this.items);
  }

  async upsert(item: WorkItem): Promise<void> {
    const checked = itemSchema.parse(item) as WorkItem;
    const index = this.items.findIndex((candidate) => candidate.id === checked.id);
    if (index >= 0) this.items[index] = checked;
    else this.items.unshift(checked);
    if (this.items.length > MAX_ITEMS) {
      // drop the oldest finished ones first; active work always stays visible
      const finished = this.items.filter((candidate) => !isActiveWork(candidate.status));
      finished.sort((a, b) => time(a.updatedAt) - time(b.updatedAt));
      const drop = new Set(finished.slice(0, this.items.length - MAX_ITEMS).map((candidate) => candidate.id));
      this.items = this.items.filter((candidate) => !drop.has(candidate.id));
    }
    await this.kv.set(KEY, this.items);
  }

  async list(): Promise<readonly WorkItem[]> {
    const { active, finished } = this.split();
    return [...active, ...finished];
  }

  async get(id: string): Promise<WorkItem | undefined> {
    return this.items.find((item) => item.id === id);
  }

  /** Active work (newest start first) and the rest (most recently updated first). */
  split(): { active: WorkItem[]; finished: WorkItem[] } {
    const now = this.now().getTime();
    const isActive = (item: WorkItem): boolean =>
      isActiveWork(item.status) && !(item.status === 'waiting' && now - time(item.updatedAt) > WAITING_STALE_MS);
    const active = this.items.filter(isActive).sort((a, b) => time(b.startedAt) - time(a.startedAt));
    const finished = this.items.filter((item) => !isActive(item)).sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
    return { active, finished };
  }
}
