import { describe, expect, it } from 'vitest';
import { DecisionStore, MAX_DECISIONS, MERCHANT_KEY } from '../../../src/skills/expenses/decisions.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { NOW } from './helpers.js';

describe('DecisionStore', () => {
  it('remembers an entry and its merchant together', async () => {
    const store = new DecisionStore(new MapKeyValueStore());
    await store.mark({
      entryId: 'e1',
      merchantKey: 'cafe',
      decision: 'claim',
      ruleId: 'lunch',
      at: NOW,
    });

    const expected = { decision: 'claim', ruleId: 'lunch', at: NOW.toISOString() };
    expect(await store.entry('e1')).toEqual(expected);
    expect(await store.merchant('cafe')).toEqual(expected);
  });

  it('keeps the entry decision when remember is off', async () => {
    const store = new DecisionStore(new MapKeyValueStore());
    await store.mark({ entryId: 'e1', decision: 'personal', at: NOW });

    expect((await store.entry('e1'))?.decision).toBe('personal');
    expect(await store.merchant('cafe')).toBeUndefined();
  });

  it('lets a newer decision for the same merchant win', async () => {
    const store = new DecisionStore(new MapKeyValueStore());
    await store.mark({ merchantKey: 'cafe', decision: 'claim', at: NOW });
    await store.mark({ merchantKey: 'cafe', decision: 'personal', at: new Date(NOW.getTime() + 1000) });

    expect((await store.merchant('cafe'))?.decision).toBe('personal');
  });

  it('prunes the oldest merchant decisions above the cap', async () => {
    const kv = new MapKeyValueStore();
    const base = NOW.getTime();
    const seed: Record<string, { decision: 'claim'; at: string }> = {};
    for (let index = 0; index < MAX_DECISIONS; index += 1) {
      seed[`m${index}`] = { decision: 'claim', at: new Date(base + index).toISOString() };
    }
    await kv.set(MERCHANT_KEY, seed);

    const store = new DecisionStore(kv);
    await store.mark({ merchantKey: 'newest', decision: 'claim', at: new Date(base + MAX_DECISIONS) });

    const stored = await kv.get<Record<string, unknown>>(MERCHANT_KEY);
    expect(stored).toBeDefined();
    const keys = Object.keys(stored ?? {});
    expect(keys).toHaveLength(MAX_DECISIONS);
    expect(keys).not.toContain('m0');
    expect(keys).toContain('newest');
  });

  it('ignores entries that are not stored anymore', async () => {
    const store = new DecisionStore(new MapKeyValueStore());
    expect(await store.entry('missing')).toBeUndefined();
    expect(await store.merchant('missing')).toBeUndefined();
  });
});
