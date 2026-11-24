import { describe, expect, it } from 'vitest';
import { lineId } from '../../../src/skills/knowledge/ids.js';
import { KnowledgeStore } from '../../../src/skills/knowledge/store.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { line } from './helpers.js';

const AT = '2026-11-17T09:00:00+09:00';

async function createStore() {
  const kv = new MapKeyValueStore();
  const store = new KnowledgeStore(kv);
  await store.load();
  return { kv, store };
}

describe('line ids', () => {
  it('ignores case, surrounding space and repeated whitespace but not field order', () => {
    const base = lineId('work', 'Acme  Corp', ' Status ');
    expect(lineId('work', ' acme corp ', 'status')).toBe(base);
    expect(lineId('work', 'acme', 'corp status')).not.toBe(base);
    expect(lineId('people', 'acme corp', 'status')).not.toBe(base);
  });
});

describe('replaceOrigin', () => {
  it('adds new lines and keeps an identical re-scan untouched', async () => {
    const { store } = await createStore();
    const first = line({ topic: 'Acme', text: '출시 준비 중' });

    expect(await store.replaceOrigin('scan', [first])).toEqual({ added: 1, retired: 0 });
    expect(await store.replaceOrigin('scan', [{ ...first, at: '2026-11-18T09:00:00+09:00' }])).toEqual({
      added: 0,
      retired: 0,
    });
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]?.at).toBe(first.at);
  });

  it('counts a changed text as added and removes lines that disappeared', async () => {
    const { store } = await createStore();
    await store.replaceOrigin('scan', [line({ topic: 'Acme', text: 'old' }), line({ topic: 'Beta', text: 'beta' })]);

    const updated = await store.replaceOrigin('scan', [line({ topic: 'Acme', text: 'new' })]);

    expect(updated).toEqual({ added: 1, retired: 1 });
    expect(store.visible().map((entry) => entry.text)).toEqual(['new']);
  });

  it('dedupes incoming lines by id, last one winning', async () => {
    const { store } = await createStore();
    await store.replaceOrigin('scan', [
      line({ topic: 'Acme', text: 'first' }),
      line({ topic: 'Acme', text: 'second' }),
    ]);

    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]?.text).toBe('second');
  });

  it('never replaces a line the owner corrected', async () => {
    const { store } = await createStore();
    const original = line({ topic: 'Acme', text: 'scanned' });
    await store.replaceOrigin('scan', [original]);
    const id = lineId(original.area, original.topic, original.key);
    await store.correct(id, 'owner words', AT);

    expect(await store.replaceOrigin('scan', [original])).toEqual({ added: 0, retired: 0 });
    expect(store.get(id)?.text).toBe('owner words');
    expect(store.get(id)?.origin).toBe('correction');
  });

  it('does not retire a corrected line either', async () => {
    const { store } = await createStore();
    const original = line({ topic: 'Acme', text: 'scanned' });
    await store.replaceOrigin('scan', [original]);
    const id = lineId(original.area, original.topic, original.key);
    await store.correct(id, 'owner words', AT);

    expect(await store.replaceOrigin('scan', [])).toEqual({ added: 0, retired: 0 });
    expect(store.visible().map((entry) => entry.id)).toEqual([id]);
  });
});

describe('correct', () => {
  it('throws for an unknown id', async () => {
    const { store } = await createStore();
    await expect(store.correct('missing', 'text', AT)).rejects.toThrow(/No knowledge line/);
  });

  it('keeps area, topic and key, trims, masks secrets and clears sources', async () => {
    const { store } = await createStore();
    const original = line({ area: 'people', topic: '민수', key: 'note', text: 'old' });
    await store.replaceOrigin('scan', [original]);
    const id = lineId(original.area, original.topic, original.key);

    await store.correct(id, `  카드 4111111111111111 메모  `, AT);

    const corrected = store.get(id);
    expect(corrected).toMatchObject({
      area: 'people',
      topic: '민수',
      key: 'note',
      origin: 'correction',
      sources: [],
      at: AT,
    });
    expect(corrected?.text).toBe('카드 [masked] 메모');
    expect(corrected?.text.length).toBeLessThanOrEqual(300);
  });

  it('stores a tombstone that hides the line and survives later scans', async () => {
    const { store } = await createStore();
    const original = line({ topic: 'Acme', text: 'wrong' });
    await store.replaceOrigin('scan', [original]);
    const id = lineId(original.area, original.topic, original.key);

    await store.correct(id, undefined, AT);
    await store.replaceOrigin('scan', [original]);

    expect(store.visible()).toEqual([]);
    expect(store.get(id)?.removed).toBe(true);
    expect(store.get(id)?.origin).toBe('correction');
  });

  it('persists corrections so a fresh store loads them', async () => {
    const { kv, store } = await createStore();
    const original = line({ topic: 'Acme', text: 'wrong' });
    await store.replaceOrigin('scan', [original]);
    const id = lineId(original.area, original.topic, original.key);
    await store.correct(id, 'fixed', AT);

    const reloaded = new KnowledgeStore(kv);
    await reloaded.load();

    expect(reloaded.get(id)?.text).toBe('fixed');
  });
});
