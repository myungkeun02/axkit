import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { KeyValueStore } from '../../core/store/types.js';
import { MAX_MENTIONS, MentionSchema } from './mentions.js';

export type CachedKind = 'file' | 'repo' | 'drive' | 'doc' | 'session';

const SummarySchema = z.object({
  stamp: z.string(),
  kind: z.enum(['file', 'repo', 'drive', 'doc', 'session']),
  path: z.string(),
  title: z.string(),
  modifiedAt: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()),
  /** The picked project (its path) a document or session belongs to. */
  project: z.string().optional(),
  /** resume, plan, proposal… (summarize.ts DOC_TYPES). */
  docType: z.string().optional(),
  /** People the document names, for the people cards and the org structure. */
  people: z.array(MentionSchema).max(MAX_MENTIONS).optional(),
});

export type CachedSummary = z.infer<typeof SummarySchema>;

const EntriesSchema = z.record(z.string(), SummarySchema);
type Entries = z.infer<typeof EntriesSchema>;

const CACHE_KEY = 'summaries';
/** Every document of a large Drive and the local folders fits; past this the oldest go first. */
const MAX_ENTRIES = 60_000;

export function cacheKey(source: string, id: string): string {
  return `${source}:${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

/** Per-file one-line summaries, keyed by source and hashed id so a rerun only summarizes changes. */
export class SummaryCache {
  private entries: Entries = {};

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    const parsed = EntriesSchema.safeParse(await this.kv.get<unknown>(CACHE_KEY));
    this.entries = parsed.success ? parsed.data : {};
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }

  get(source: string, id: string): CachedSummary | undefined {
    return this.entries[cacheKey(source, id)];
  }

  put(source: string, id: string, summary: CachedSummary): void {
    this.entries[cacheKey(source, id)] = summary;
    this.evict();
  }

  /** Drops entries for this source that the latest walk did not see. */
  prune(source: string, seenIds: Iterable<string>): void {
    const keep = new Set<string>();
    for (const id of seenIds) keep.add(cacheKey(source, id));
    const prefix = `${source}:`;
    const next: Entries = {};
    for (const [key, entry] of Object.entries(this.entries)) {
      if (key.startsWith(prefix) && !keep.has(key)) continue;
      next[key] = entry;
    }
    this.entries = next;
  }

  async save(): Promise<void> {
    await this.kv.set(CACHE_KEY, this.entries);
  }

  private evict(): void {
    while (Object.keys(this.entries).length > MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestAt: string | undefined;
      for (const [key, entry] of Object.entries(this.entries)) {
        if (oldestAt === undefined || entry.modifiedAt < oldestAt) {
          oldestAt = entry.modifiedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      const next: Entries = {};
      for (const [key, entry] of Object.entries(this.entries)) {
        if (key !== oldestKey) next[key] = entry;
      }
      this.entries = next;
    }
  }
}
