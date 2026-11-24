import { describe, expect, it } from 'vitest';
import { MAX_OWNER_RULES, KvRuleStore, matchRule } from '../../../src/skills/expenses/rules.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { entry, rule } from './helpers.js';

const TZ = 'Asia/Seoul';

describe('matchRule', () => {
  it('matches a weekday lunch window in the owner time zone', () => {
    const lunch = rule({
      categories: ['food'],
      weekdaysOnly: true,
      timeFrom: '11:00',
      timeTo: '14:00',
      maxAmount: 15_000,
    });

    expect(matchRule(entry({ at: '2026-11-17T12:00:00+09:00' }), lunch, TZ)).toBe(true);
    expect(matchRule(entry({ at: '2026-11-21T12:00:00+09:00' }), lunch, TZ)).toBe(false);
    expect(matchRule(entry({ at: '2026-11-17T15:00:00+09:00' }), lunch, TZ)).toBe(false);
    expect(matchRule(entry({ at: '2026-11-17T03:00:00Z' }), lunch, TZ)).toBe(true);
    expect(matchRule(entry({ at: '2026-11-17T03:00:00Z' }), lunch, 'UTC')).toBe(false);
  });

  it('filters by category and by case-insensitive merchant substring', () => {
    const workTools = rule({ id: 'ai_tools', categories: ['ai', 'infra'] });
    expect(matchRule(entry({ category: 'food' }), workTools, TZ)).toBe(false);

    const openai = rule({ id: 'openai', merchants: ['openai'] });
    expect(matchRule(entry({ merchant: 'OpenAI, Inc.', merchantKey: 'openai-inc' }), openai, TZ)).toBe(true);
    expect(matchRule(entry({ merchant: 'OPENAI' }), openai, TZ)).toBe(true);
    expect(matchRule(entry({ merchant: '카페 예시' }), openai, TZ)).toBe(false);
  });

  it('treats amount bounds as inclusive', () => {
    const bounded = rule({ minAmount: 5_000, maxAmount: 15_000 });
    expect(matchRule(entry({ amount: 5_000 }), bounded, TZ)).toBe(true);
    expect(matchRule(entry({ amount: 15_000 }), bounded, TZ)).toBe(true);
    expect(matchRule(entry({ amount: 4_999 }), bounded, TZ)).toBe(false);
    expect(matchRule(entry({ amount: 15_001 }), bounded, TZ)).toBe(false);
  });

  it('accepts a single time bound', () => {
    const morningOnly = rule({ timeFrom: '09:00' });
    expect(matchRule(entry({ at: '2026-11-17T08:59:00+09:00' }), morningOnly, TZ)).toBe(false);
    expect(matchRule(entry({ at: '2026-11-17T09:00:00+09:00' }), morningOnly, TZ)).toBe(true);

    const untilNoon = rule({ timeTo: '12:00' });
    expect(matchRule(entry({ at: '2026-11-17T12:00:00+09:00' }), untilNoon, TZ)).toBe(true);
    expect(matchRule(entry({ at: '2026-11-17T12:01:00+09:00' }), untilNoon, TZ)).toBe(false);
  });

  it('matches everything when the rule states no condition', () => {
    expect(matchRule(entry(), rule({}), TZ)).toBe(true);
  });
});

describe('KvRuleStore', () => {
  it('combines config rules and stored owner rules', async () => {
    const store = new KvRuleStore(new MapKeyValueStore(), [rule({ id: 'config_rule', name: 'Config' })]);

    expect(await store.add(rule({ id: 'owner_rule', name: 'Owner' }))).toBe('added');
    const all = await store.all();

    expect(all.map((tagged) => [tagged.rule.id, tagged.source])).toEqual([
      ['config_rule', 'config'],
      ['owner_rule', 'owner'],
    ]);
  });

  it('rejects duplicate ids and keeps config rules read-only', async () => {
    const store = new KvRuleStore(new MapKeyValueStore(), [rule({ id: 'config_rule' })]);
    await store.add(rule({ id: 'owner_rule' }));

    expect(await store.add(rule({ id: 'config_rule' }))).toBe('duplicate');
    expect(await store.add(rule({ id: 'owner_rule' }))).toBe('duplicate');
    expect(await store.remove('config_rule')).toBe('config');
    expect(await store.remove('missing')).toBe('missing');
    expect(await store.remove('owner_rule')).toBe('removed');
    expect(await store.owner()).toEqual([]);
  });

  it('caps stored rules', async () => {
    const store = new KvRuleStore(new MapKeyValueStore(), []);
    for (let index = 0; index < MAX_OWNER_RULES; index += 1) {
      expect(await store.add(rule({ id: `rule_${index}` }))).toBe('added');
    }
    expect(await store.add(rule({ id: 'rule_overflow' }))).toBe('full');
  });
});
