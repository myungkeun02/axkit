import { describe, expect, it } from 'vitest';
import { addEntry, addSeen, loadMonth, loadSeen, MONTH_CAP, SEEN_CAP } from '../../../src/skills/receipts/store.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { docEntry } from './helpers.js';

describe('document month index', () => {
  it('keeps the newest 1000 entries', async () => {
    const kv = new MapKeyValueStore();
    const seeded = Array.from({ length: MONTH_CAP }, (_, index) =>
      docEntry({
        id: `doc-${index}`,
        mailId: `mail-${index}`,
        at: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(),
      }),
    );
    await kv.set('docs:2026-11', seeded);
    for (let index = MONTH_CAP; index < MONTH_CAP + 5; index += 1) {
      await addEntry(
        kv,
        '2026-11',
        docEntry({
          id: `doc-${index}`,
          mailId: `mail-${index}`,
          at: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(),
        }),
      );
    }

    const entries = await loadMonth(kv, '2026-11');
    expect(entries).toHaveLength(MONTH_CAP);
    expect(entries[0]?.id).toBe('doc-5');
    expect(entries.at(-1)?.id).toBe(`doc-${MONTH_CAP + 4}`);
  });

  it('ignores corrupt stored entries', async () => {
    const kv = new MapKeyValueStore();
    await kv.set('docs:2026-11', [docEntry(), { id: 1 }, null, 'nope']);

    const entries = await loadMonth(kv, '2026-11');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('doc-1');
  });

  it('returns an empty list for a missing or non-array value', async () => {
    const kv = new MapKeyValueStore();
    expect(await loadMonth(kv, '2026-10')).toEqual([]);
    await kv.set('docs:2026-10', { nope: true });
    expect(await loadMonth(kv, '2026-10')).toEqual([]);
  });
});

describe('seen ids', () => {
  it('keeps the newest 5000 ids', async () => {
    const kv = new MapKeyValueStore();
    await addSeen(
      kv,
      Array.from({ length: SEEN_CAP + 1 }, (_, index) => `mail-${index}`),
    );

    const seen = await loadSeen(kv);
    expect(seen).toHaveLength(SEEN_CAP);
    expect(seen[0]).toBe('mail-1');
    expect(seen.at(-1)).toBe(`mail-${SEEN_CAP}`);
  });

  it('deduplicates ids and ignores empty values', async () => {
    const kv = new MapKeyValueStore();
    await addSeen(kv, ['a', 'b', 'a', '']);
    expect(await loadSeen(kv)).toEqual(['a', 'b']);
  });
});
