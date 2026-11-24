import { describe, expect, it } from 'vitest';
import {
  FileIndex,
  MAX_DOCS,
  MAX_TOKENS_PER_DOC,
  SNIPPET_CHARS,
  docKey,
} from '../../../src/skills/files/store.js';
import type { StoredDoc } from '../../../src/skills/files/store.js';
import { MapKeyValueStore } from '../../core/helpers.js';

function doc(id: string, chunks: string[], modifiedAt = '2026-11-17T00:00:00.000Z'): StoredDoc {
  return { source: 'local', id, name: id, path: `Files/${id}`, modifiedAt, chunks };
}

describe('FileIndex', () => {
  it('finds documents by tokens and ranks the best match first', async () => {
    const index = new FileIndex(new MapKeyValueStore());
    await index.put(doc('a', ['alpha beta'], '2026-11-17T03:00:00.000Z'));
    await index.put(doc('b', ['alpha only'], '2026-11-17T02:00:00.000Z'));
    await index.put(doc('c', ['beta beta'], '2026-11-17T01:00:00.000Z'));
    await index.save();

    const hits = await index.search('alpha beta', 5);

    expect(hits.map((hit) => hit.doc.id)).toEqual(['a', 'c', 'b']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('matches Korean words through their two-character prefix', async () => {
    const index = new FileIndex(new MapKeyValueStore());
    await index.put(doc('meeting', ['회의록에서 결정했어요']));

    const hits = await index.search('회의록', 5);

    expect(hits.map((hit) => hit.doc.id)).toEqual(['meeting']);
  });

  it('limits the snippet and picks the chunk holding the query', async () => {
    const index = new FileIndex(new MapKeyValueStore());
    await index.put(doc('long', ['x'.repeat(500), `needle ${'y'.repeat(500)}`]));

    const hits = await index.search('needle', 5);

    expect(hits[0]?.snippet).toContain('needle');
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS);
  });

  it('replaces the tokens of an updated file', async () => {
    const kv = new MapKeyValueStore();
    const index = new FileIndex(kv);
    await index.put(doc('a', ['oldword']));
    await index.put(doc('a', ['newword']));
    await index.save();

    const fresh = new FileIndex(kv);
    await expect(fresh.search('oldword', 5)).resolves.toEqual([]);
    await expect(fresh.search('newword', 5)).resolves.toEqual([
      expect.objectContaining({ doc: expect.objectContaining({ id: 'a' }) }),
    ]);
    expect(await fresh.get('local', 'a')).toMatchObject({ chunks: ['newword'] });
  });

  it('keeps at most 300 distinct tokens per document', async () => {
    const index = new FileIndex(new MapKeyValueStore());
    const chunks = [Array.from({ length: 400 }, (_, at) => `word${String(at).padStart(3, '0')}`).join(' ')];
    await index.put(doc('many', chunks));

    expect(await index.search('word299', 5)).toHaveLength(1);
    expect(await index.search('word300', 5)).toHaveLength(0);
    expect(MAX_TOKENS_PER_DOC).toBe(300);
  });

  it('evicts the oldest document past the cap and removes its tokens', async () => {
    const index = new FileIndex(new MapKeyValueStore());
    for (let at = 0; at <= MAX_DOCS; at += 1) {
      await index.put(doc(`f${at}`, [`term${at}`], new Date(1_000 + at * 1_000).toISOString()));
    }
    await index.save();

    expect(MAX_DOCS).toBe(3_000);
    expect(await index.search('term0', 5)).toEqual([]);
    expect(await index.get('local', 'f0')).toBeUndefined();
    expect(await index.search(`term${MAX_DOCS}`, 5)).toHaveLength(1);
  }, 30_000);

  it('stores and reads cursors', async () => {
    const index = new FileIndex(new MapKeyValueStore());
    expect(await index.cursor('local')).toBeUndefined();

    await index.setCursor('local', '2026-11-17T05:00:00.000Z');
    expect(await index.cursor('local')).toEqual(new Date('2026-11-17T05:00:00.000Z'));

    await index.setCursor('drive', 'not-a-date');
    expect(await index.cursor('drive')).toBeUndefined();
  });

  it('derives stable short keys per source and id', () => {
    expect(docKey('local', '/a/b.txt')).toHaveLength(16);
    expect(docKey('local', '/a/b.txt')).toBe(docKey('local', '/a/b.txt'));
    expect(docKey('drive', '/a/b.txt')).not.toBe(docKey('local', '/a/b.txt'));
  });
});
