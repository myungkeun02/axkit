import { createHash } from 'node:crypto';
import type { KeyValueStore } from '../../core/store/types.js';
import { tokenSet, tokenize } from './tokens.js';

export const MAX_DOCS = 3_000;
export const MAX_TOKENS_PER_DOC = 300;
export const SNIPPET_CHARS = 300;

export interface StoredDoc {
  source: string;
  id: string;
  name: string;
  path: string;
  modifiedAt: string;
  chunks: string[];
}

interface DocMeta {
  key: string;
  modifiedAt: string;
  /** Kept with the key so deletions find their docs without reading each one (absent in older stores). */
  source?: string;
  id?: string;
}

/** What is in the index for a source, without the text. */
export interface IndexedDoc {
  source: string;
  id: string;
  modifiedAt: string;
}

export interface FileHit {
  doc: StoredDoc;
  score: number;
  snippet: string;
}

const INDEX_KEY = 'index';
const DOCS_KEY = 'docs';
const DOC_PREFIX = 'doc:';
const CURSOR_PREFIX = 'cursor:';

export function docKey(source: string, id: string): string {
  return createHash('sha1').update(`${source}${id}`).digest('hex').slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredDoc(value: unknown): value is StoredDoc {
  if (!isRecord(value)) return false;
  return (
    typeof value.source === 'string' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    typeof value.modifiedAt === 'string' &&
    Array.isArray(value.chunks) &&
    value.chunks.every((chunk) => typeof chunk === 'string')
  );
}

function readIndex(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const index: Record<string, string[]> = {};
  for (const [token, keys] of Object.entries(value)) {
    if (Array.isArray(keys) && keys.every((key) => typeof key === 'string')) index[token] = keys;
  }
  return index;
}

function readMeta(value: unknown): DocMeta[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.key === 'string' && typeof entry.modifiedAt === 'string'
      ? [
          {
            key: entry.key,
            modifiedAt: entry.modifiedAt,
            ...(typeof entry.source === 'string' && typeof entry.id === 'string' ? { source: entry.source, id: entry.id } : {}),
          },
        ]
      : [],
  );
}

function countOccurrences(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(token, from);
      if (at < 0) break;
      total += 1;
      from = at + token.length;
      if (total >= 100) return total;
    }
  }
  return total;
}

function chunkScore(chunk: string, tokens: readonly string[]): number {
  const lower = chunk.toLowerCase();
  const distinct = tokens.filter((token) => lower.includes(token)).length;
  return distinct * 10 + Math.min(countOccurrences(chunk, tokens), 9);
}

function bestChunk(chunks: readonly string[], tokens: readonly string[]): string {
  let best = chunks[0] ?? '';
  let bestScore = -1;
  for (const chunk of chunks) {
    const score = chunkScore(chunk, tokens);
    if (score > bestScore) {
      best = chunk;
      bestScore = score;
    }
  }
  return best;
}

function snippetOf(chunk: string): string {
  return chunk.length <= SNIPPET_CHARS ? chunk : chunk.slice(0, SNIPPET_CHARS);
}

/** Token index over the owner's files, kept in the plugin's key-value store. */
export class FileIndex {
  private index: Record<string, string[]> = {};
  private meta: DocMeta[] = [];
  private loaded = false;

  constructor(private readonly kv: KeyValueStore) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const [rawIndex, rawMeta] = await Promise.all([this.kv.get<unknown>(INDEX_KEY), this.kv.get<unknown>(DOCS_KEY)]);
    this.index = readIndex(rawIndex);
    this.meta = readMeta(rawMeta);
    this.loaded = true;
  }

  async save(): Promise<void> {
    await Promise.all([this.kv.set(INDEX_KEY, this.index), this.kv.set(DOCS_KEY, this.meta)]);
  }

  async get(source: string, id: string): Promise<StoredDoc | undefined> {
    await this.ensureLoaded();
    return this.readDoc(docKey(source, id));
  }

  async put(doc: StoredDoc): Promise<void> {
    await this.ensureLoaded();
    const key = docKey(doc.source, doc.id);
    await this.remove(key);

    const tokens = tokenSet(doc.chunks.join('\n')).slice(0, MAX_TOKENS_PER_DOC);
    for (const token of tokens) {
      const keys = this.index[token] ?? [];
      if (!keys.includes(key)) keys.push(key);
      this.index[token] = keys;
    }
    this.meta.push({ key, modifiedAt: doc.modifiedAt, source: doc.source, id: doc.id });
    await this.kv.set(DOC_PREFIX + key, doc);
    await this.evict();
  }

  async search(query: string, limit: number): Promise<FileHit[]> {
    await this.ensureLoaded();
    const tokens = [...new Set(tokenize(query))];
    if (tokens.length === 0 || limit <= 0) return [];

    const matched = new Map<string, number>();
    for (const token of tokens) {
      for (const key of this.index[token] ?? []) {
        matched.set(key, (matched.get(key) ?? 0) + 1);
      }
    }

    const hits: FileHit[] = [];
    for (const [key, distinct] of matched) {
      const doc = await this.readDoc(key);
      if (doc === undefined) continue;
      const chunk = bestChunk(doc.chunks, tokens);
      hits.push({
        doc,
        score: distinct * 10 + Math.min(countOccurrences(chunk, tokens), 9),
        snippet: snippetOf(chunk),
      });
    }
    hits.sort(
      (left, right) =>
        right.score - left.score ||
        right.doc.modifiedAt.localeCompare(left.doc.modifiedAt) ||
        left.doc.path.localeCompare(right.doc.path),
    );
    return hits.slice(0, limit);
  }

  /** Every doc of one source (ids and times only). */
  async docs(source: string): Promise<IndexedDoc[]> {
    await this.ensureLoaded();
    await this.backfillMeta();
    return this.meta.flatMap((entry) =>
      entry.source === source && entry.id !== undefined ? [{ source, id: entry.id, modifiedAt: entry.modifiedAt }] : [],
    );
  }

  /** Drops the doc `id` and, when `id` is a folder, every doc below it. Answers what was dropped. */
  async removeUnder(source: string, id: string): Promise<IndexedDoc[]> {
    const prefix = id.endsWith('/') ? id : `${id}/`;
    const gone = (await this.docs(source)).filter((doc) => doc.id === id || doc.id.startsWith(prefix));
    for (const doc of gone) await this.remove(docKey(source, doc.id));
    return gone;
  }

  async cursor(label: string): Promise<Date | undefined> {
    const iso = await this.kv.get<unknown>(`${CURSOR_PREFIX}${label}`);
    if (typeof iso !== 'string') return undefined;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  async setCursor(label: string, iso: string): Promise<void> {
    await this.kv.set(`${CURSOR_PREFIX}${label}`, iso);
  }

  private async backfillMeta(): Promise<void> {
    for (const entry of this.meta) {
      if (entry.id !== undefined) continue;
      const doc = await this.readDoc(entry.key);
      if (doc === undefined) continue;
      entry.source = doc.source;
      entry.id = doc.id;
    }
  }

  private async readDoc(key: string): Promise<StoredDoc | undefined> {
    const stored = await this.kv.get<unknown>(DOC_PREFIX + key);
    return isStoredDoc(stored) ? stored : undefined;
  }

  private async remove(key: string): Promise<void> {
    const nextIndex: Record<string, string[]> = {};
    for (const [token, keys] of Object.entries(this.index)) {
      if (!keys.includes(key)) {
        nextIndex[token] = keys;
        continue;
      }
      const remaining = keys.filter((entry) => entry !== key);
      if (remaining.length > 0) nextIndex[token] = remaining;
    }
    this.index = nextIndex;
    this.meta = this.meta.filter((entry) => entry.key !== key);
    await this.kv.delete(DOC_PREFIX + key);
  }

  private async evict(): Promise<void> {
    while (this.meta.length > MAX_DOCS) {
      const oldest = this.meta.reduce((left, right) => (left.modifiedAt <= right.modifiedAt ? left : right));
      await this.remove(oldest.key);
    }
  }
}
