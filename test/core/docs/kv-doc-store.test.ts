import { describe, expect, it } from 'vitest';
import type { DocInput } from '../../../src/core/contracts/docs.js';
import { KvDocStore } from '../../../src/core/docs/kv-doc-store.js';
import { MapKeyValueStore } from '../helpers.js';

const BASE = new Date('2026-11-17T09:00:00+09:00').getTime();

function make() {
  let tick = 0;
  const kv = new MapKeyValueStore();
  const store = new KvDocStore(kv, () => new Date(BASE + tick++ * 1000));
  return { store, kv };
}

function input(id: string, overrides: Partial<DocInput> = {}): DocInput {
  return {
    id,
    kind: 'decision',
    scope: 'company',
    title: `Title ${id}`,
    body: 'Body',
    author: { kind: 'agent', id: 'skill.tuning' },
    ...overrides,
  };
}

describe('KvDocStore', () => {
  it('creates a document with no entries and marks it verified', async () => {
    const { store } = make();
    const doc = await store.upsert(input('company:team:dev', { basedOnFacts: ['fact:launch'] }));

    expect(doc).toMatchObject({
      id: 'company:team:dev',
      kind: 'decision',
      scope: 'company',
      title: 'Title company:team:dev',
      body: 'Body',
      needsReview: false,
      basedOnFacts: ['fact:launch'],
    });
    expect(doc.entries).toEqual([]);
    expect(doc.lastVerifiedAt).toBe(doc.updatedAt);
    expect(await store.get('company:team:dev')).toEqual(doc);
  });

  it('rejects invalid ids on every id-taking operation', async () => {
    const { store } = make();
    for (const id of ['', 'Upper', '-start', 'a b', 'a'.repeat(121)]) {
      await expect(store.get(id)).rejects.toThrow('Invalid doc id');
      await expect(store.upsert(input(id))).rejects.toThrow('Invalid doc id');
      await expect(store.append(id, { text: 'x', author: { kind: 'user', id: 'owner' }, sources: [] })).rejects.toThrow(
        'Invalid doc id',
      );
      await expect(store.verify(id)).rejects.toThrow('Invalid doc id');
    }
    for (const id of ['a', 'x_y.z-1', 'company:decisions:dev']) {
      await expect(store.upsert(input(id))).resolves.toMatchObject({ id });
    }
  });

  it('replaces the body while keeping entries, and clears the review flag', async () => {
    const { store } = make();
    await store.upsert(input('doc:a', { basedOnFacts: ['fact:launch'] }));
    await store.append('doc:a', { text: 'first note', author: { kind: 'user', id: 'owner' }, sources: ['mail:1'] });
    expect(await store.flagFact('fact:launch', '사실 만료')).toEqual(['doc:a']);
    expect((await store.get('doc:a'))?.needsReview).toBe(true);

    const updated = await store.upsert(
      input('doc:a', { title: 'New title', body: 'New body', basedOnFacts: ['fact:other'] }),
    );

    expect(updated.entries).toHaveLength(1);
    expect(updated.entries[0]).toMatchObject({ text: 'first note', author: { kind: 'user', id: 'owner' }, sources: ['mail:1'] });
    expect(updated.title).toBe('New title');
    expect(updated.body).toBe('New body');
    expect(updated.basedOnFacts).toEqual(['fact:other']);
    expect(updated.needsReview).toBe(false);
    expect(updated.reviewReason).toBeUndefined();
  });

  it('returns undefined when appending to a missing document', async () => {
    const { store } = make();
    expect(await store.append('doc:missing', { text: 'x', author: { kind: 'user', id: 'owner' }, sources: [] })).toBeUndefined();
  });

  it('trims and clips entry text and sets updatedAt', async () => {
    const { store } = make();
    await store.upsert(input('doc:a'));
    const long = await store.append('doc:a', { text: `  ${'x'.repeat(1100)}  `, author: { kind: 'agent', id: 'skill.memory' }, sources: [] });
    const short = await store.append('doc:a', { text: '  hello  ', author: { kind: 'user', id: 'owner' }, sources: [] });

    expect(long?.entries[0]?.text).toHaveLength(1000);
    expect(short?.entries[1]?.text).toBe('hello');
    expect((short?.updatedAt ?? '') > (long?.updatedAt ?? '')).toBe(true);
    expect(long?.entries[0]?.at).toBe(long?.updatedAt);
  });

  it('keeps at most 300 entries, dropping the oldest', async () => {
    const { store } = make();
    await store.upsert(input('doc:a'));
    for (let i = 0; i < 305; i += 1) {
      await store.append('doc:a', { text: `e${i}`, author: { kind: 'agent', id: 'skill.memory' }, sources: [] });
    }
    const doc = await store.get('doc:a');
    expect(doc?.entries).toHaveLength(300);
    expect(doc?.entries[0]?.text).toBe('e5');
    expect(doc?.entries.at(-1)?.text).toBe('e304');
  });

  it('filters by kind, scope and needsReview, newest update first', async () => {
    const { store } = make();
    await store.upsert(input('doc:a', { kind: 'team', scope: 'team:dev' }));
    await store.upsert(input('doc:b', { kind: 'decision', scope: 'company' }));
    await store.upsert(input('doc:c', { kind: 'decision', scope: 'company', basedOnFacts: ['fact:x'] }));
    await store.flagFact('fact:x', '바뀐 사실');

    expect((await store.list()).map((doc) => doc.id)).toEqual(['doc:c', 'doc:b', 'doc:a']);
    expect((await store.list({ kind: 'decision' })).map((doc) => doc.id)).toEqual(['doc:c', 'doc:b']);
    expect((await store.list({ scope: 'team:dev' })).map((doc) => doc.id)).toEqual(['doc:a']);
    expect((await store.list({ needsReview: true })).map((doc) => doc.id)).toEqual(['doc:c']);
    expect((await store.list({ needsReview: false, kind: 'decision' })).map((doc) => doc.id)).toEqual(['doc:b']);
  });

  it('flags every document based on a fact and verifies one', async () => {
    const { store } = make();
    await store.upsert(input('doc:a', { basedOnFacts: ['fact:1', 'fact:2'] }));
    await store.upsert(input('doc:b', { basedOnFacts: ['fact:2'] }));
    await store.upsert(input('doc:c', { basedOnFacts: ['fact:3'] }));

    expect(await store.flagFact('fact:2', '출시일이 지났어요')).toEqual(['doc:b', 'doc:a']);
    expect(await store.flagFact('fact:none', 'x')).toEqual([]);
    expect((await store.get('doc:a'))?.reviewReason).toBe('출시일이 지났어요');
    expect((await store.get('doc:c'))?.needsReview).toBe(false);

    const before = (await store.get('doc:a'))?.lastVerifiedAt;
    await store.verify('doc:a');
    const verified = await store.get('doc:a');
    expect(verified?.needsReview).toBe(false);
    expect(verified?.reviewReason).toBeUndefined();
    expect(verified?.lastVerifiedAt !== before).toBe(true);

    await expect(store.verify('doc:missing')).resolves.toBeUndefined();
  });

  it('ignores malformed stored values and a malformed index', async () => {
    const { store, kv } = make();
    await store.upsert(input('doc:ok'));
    await kv.set('doc:ghost', { id: 'ghost' });
    await kv.set('docs:index', ['ghost', 'doc:ok']);
    expect((await store.list()).map((doc) => doc.id)).toEqual(['doc:ok']);

    await kv.set('docs:index', 'not a list');
    expect(await store.list()).toEqual([]);
  });

  it('caps the index at 2000, dropping the oldest-updated document and its key', async () => {
    const { store, kv } = make();
    for (let i = 0; i < 2001; i += 1) {
      const id = `d${String(i).padStart(4, '0')}`;
      await store.upsert(input(id));
    }
    const ids = (await kv.get<string[]>('docs:index')) ?? [];
    expect(ids).toHaveLength(2000);
    expect(await kv.get('doc:d0000')).toBeUndefined();
    expect(await kv.get('doc:d0001')).toBeDefined();
  });
});
