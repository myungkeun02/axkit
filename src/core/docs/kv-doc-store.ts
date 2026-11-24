import type { Doc, DocEntry, DocInput, DocQuery, DocStore } from '../contracts/docs.js';
import type { KeyValueStore } from '../store/types.js';

const DOC_PREFIX = 'doc:';
const INDEX_KEY = 'docs:index';
const MAX_DOCS = 2000;
const MAX_ENTRIES = 300;
const MAX_ENTRY_TEXT = 1000;
const DOC_ID = /^[a-z0-9][a-z0-9:._-]{0,119}$/;

function assertDocId(id: string): void {
  if (!DOC_ID.test(id)) throw new Error('Invalid doc id');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDoc(value: unknown): value is Doc {
  if (value === null || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.id === 'string' &&
    typeof doc.kind === 'string' &&
    typeof doc.scope === 'string' &&
    typeof doc.title === 'string' &&
    typeof doc.body === 'string' &&
    Array.isArray(doc.entries) &&
    Array.isArray(doc.basedOnFacts) &&
    typeof doc.needsReview === 'boolean' &&
    typeof doc.updatedAt === 'string' &&
    (doc.reviewReason === undefined || typeof doc.reviewReason === 'string') &&
    (doc.lastVerifiedAt === undefined || typeof doc.lastVerifiedAt === 'string')
  );
}

function docKey(id: string): string {
  return `${DOC_PREFIX}${id}`;
}

/** One key per document plus an id index, so listing does not scan the whole key-value store. */
export class KvDocStore implements DocStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date,
  ) {}

  async get(id: string): Promise<Doc | undefined> {
    assertDocId(id);
    return this.read(id);
  }

  async list(query: DocQuery = {}): Promise<Doc[]> {
    const docs: Doc[] = [];
    for (const id of await this.readIndex()) {
      const doc = await this.read(id);
      if (doc === undefined) continue;
      if (query.kind !== undefined && doc.kind !== query.kind) continue;
      if (query.scope !== undefined && doc.scope !== query.scope) continue;
      if (query.needsReview !== undefined && doc.needsReview !== query.needsReview) continue;
      docs.push(doc);
    }
    return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async upsert(input: DocInput): Promise<Doc> {
    assertDocId(input.id);
    const existing = await this.read(input.id);
    const at = this.now().toISOString();
    const doc: Doc = {
      id: input.id,
      kind: input.kind,
      scope: input.scope,
      title: input.title,
      body: input.body,
      entries: [...(existing?.entries ?? [])],
      basedOnFacts: [...(input.basedOnFacts ?? [])],
      needsReview: false,
      lastVerifiedAt: at,
      updatedAt: at,
    };
    await this.save(doc);
    return doc;
  }

  async append(id: string, entry: Omit<DocEntry, 'at'>): Promise<Doc | undefined> {
    assertDocId(id);
    const existing = await this.read(id);
    if (existing === undefined) return undefined;
    const text = entry.text.trim().slice(0, MAX_ENTRY_TEXT);
    const at = this.now().toISOString();
    const entries = [...existing.entries, { at, text, author: entry.author, sources: [...entry.sources] }];
    const doc: Doc = {
      ...existing,
      entries: entries.slice(-MAX_ENTRIES),
      updatedAt: at,
    };
    await this.save(doc);
    return doc;
  }

  async verify(id: string): Promise<void> {
    assertDocId(id);
    const doc = await this.read(id);
    if (doc === undefined) return;
    await this.kv.set(docKey(id), {
      id: doc.id,
      kind: doc.kind,
      scope: doc.scope,
      title: doc.title,
      body: doc.body,
      entries: doc.entries,
      basedOnFacts: doc.basedOnFacts,
      needsReview: false,
      lastVerifiedAt: this.now().toISOString(),
      updatedAt: doc.updatedAt,
    } satisfies Doc);
  }

  async flagFact(factId: string, reason: string): Promise<string[]> {
    const flagged: string[] = [];
    for (const doc of await this.list()) {
      if (!doc.basedOnFacts.includes(factId)) continue;
      await this.kv.set(docKey(doc.id), { ...doc, needsReview: true, reviewReason: reason } satisfies Doc);
      flagged.push(doc.id);
    }
    return flagged;
  }

  private async read(id: string): Promise<Doc | undefined> {
    const raw = await this.kv.get<unknown>(docKey(id));
    return isDoc(raw) ? raw : undefined;
  }

  private async readIndex(): Promise<string[]> {
    const raw = await this.kv.get<unknown>(INDEX_KEY);
    return isStringArray(raw) ? [...raw] : [];
  }

  private async save(doc: Doc): Promise<void> {
    await this.kv.set(docKey(doc.id), doc);
    const index = (await this.readIndex()).filter((id) => id !== doc.id);
    index.push(doc.id);
    if (index.length > MAX_DOCS) {
      await this.trim(index);
      return;
    }
    await this.kv.set(INDEX_KEY, index);
  }

  /** Drops the oldest-updated documents (and their keys) once the index is over the cap. */
  private async trim(index: string[]): Promise<void> {
    const known: { id: string; updatedAt: string }[] = [];
    for (const id of index) {
      const doc = await this.read(id);
      if (doc !== undefined) known.push({ id, updatedAt: doc.updatedAt });
    }
    known.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const excess = Math.max(0, known.length - MAX_DOCS);
    for (let i = 0; i < excess; i += 1) {
      const victim = known[i];
      if (victim !== undefined) await this.kv.delete(docKey(victim.id));
    }
    await this.kv.set(
      INDEX_KEY,
      known.slice(excess).map((entry) => entry.id),
    );
  }
}
