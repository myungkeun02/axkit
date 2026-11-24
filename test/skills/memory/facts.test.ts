import { describe, expect, it } from 'vitest';
import { FactStore } from '../../../src/skills/memory/facts.js';
import { maskSecrets } from '../../../src/skills/memory/mask.js';
import { personKey } from '../../../src/skills/memory/people-keys.js';
import { tokenize } from '../../../src/skills/memory/tokens.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';

const DAY_MS = 86_400_000;

async function createStore(start = '2026-01-01T00:00:00+09:00') {
  const clock = new FakeClock(new Date(start));
  const store = new FactStore(new MapKeyValueStore(), () => clock.now());
  await store.load();
  return { clock, store };
}

describe('fact decay', () => {
  it('halves strength after one half-life and keeps decaying', async () => {
    const { clock, store } = await createStore();

    const fresh = await store.remember({
      subject: 'owner',
      text: '커피는 아메리카노를 즐김',
      source: { kind: 'interview' },
      halfLifeDays: 365,
    });
    expect(fresh.strength).toBeCloseTo(1, 5);

    await clock.advance(365 * DAY_MS);
    const [half] = await store.recall({ subject: 'owner', limit: 5 });
    expect(half?.strength).toBeCloseTo(0.5, 5);

    await clock.advance(365 * DAY_MS);
    const [quarter] = await store.recall({ subject: 'owner', limit: 5 });
    expect(quarter?.strength).toBeCloseTo(0.25, 5);
  });

  it('drops facts weaker than 0.05 from recall', async () => {
    const { clock, store } = await createStore();
    await store.remember({ subject: 'owner', text: '오늘은 비가 온다고 함', source: { kind: 'chat' } });

    await clock.advance(400 * DAY_MS);

    expect(await store.recall({ subject: 'owner', limit: 5 })).toEqual([]);
  });
});

describe('fact confirmation', () => {
  it('confirms the same fact instead of duplicating it', async () => {
    const { clock, store } = await createStore();
    await store.remember({ subject: 'owner', text: '커피는 아메리카노', source: { kind: 'chat' } });
    const learnedAt = store.all()[0]?.confirmedAt;

    await clock.advance(10 * DAY_MS);
    const again = await store.remember({
      subject: 'owner',
      text: '  커피는   아메리카노  ',
      source: { kind: 'chat' },
    });

    expect(store.all()).toHaveLength(1);
    expect(again.strength).toBeCloseTo(1, 5);
    expect(store.all()[0]?.learnedAt).toBe(learnedAt);
    expect(store.all()[0]?.confirmedAt).not.toBe(learnedAt);
  });

  it('replaces an interview answer when the question is answered again', async () => {
    const { store } = await createStore();
    await store.remember({
      subject: 'owner',
      text: '집중은 아침에 잘 된다',
      source: { kind: 'interview', ref: 'focus_time' },
      halfLifeDays: 365,
    });

    await store.remember({
      subject: 'owner',
      text: '집중은 밤에 잘 된다',
      source: { kind: 'interview', ref: 'focus_time' },
      halfLifeDays: 365,
    });

    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({
      text: '집중은 밤에 잘 된다',
      source: { kind: 'interview', ref: 'focus_time' },
    });
  });
});

describe('fact recall', () => {
  it('ranks by token overlap and ignores unrelated facts', async () => {
    const { store } = await createStore();
    await store.remember({ subject: 'owner', text: '주말에는 집에서 쉼', source: { kind: 'chat' } });
    await store.remember({ subject: 'owner', text: '주말에는 등산을 감', source: { kind: 'chat' } });
    await store.remember({ subject: 'owner', text: '커피는 아메리카노', source: { kind: 'chat' } });

    const facts = await store.recall({ text: '주말 등산 어때', limit: 5 });

    expect(facts.map((fact) => fact.text)).toEqual(['주말에는 등산을 감', '주말에는 집에서 쉼']);
  });

  it('filters by subject and respects the limit', async () => {
    const { store } = await createStore();
    await store.remember({ subject: 'owner', text: '아침형 인간', source: { kind: 'chat' } });
    await store.remember({ subject: '민수', text: '등산을 좋아함', source: { kind: 'chat' } });
    await store.remember({ subject: '민수', text: '커피를 좋아함', source: { kind: 'chat' } });

    expect(await store.recall({ subject: '민수', limit: 1 })).toHaveLength(1);
    expect((await store.recall({ subject: '민수', limit: 5 }))[0]?.subject).toBe('민수');
  });
});

describe('secrets', () => {
  it('masks token-like and card-like strings before storing', async () => {
    const { store } = await createStore();
    const secret = 'abcdefghijklmnopqrstuvwxyz012345';

    const fact = await store.remember({
      subject: 'owner',
      text: `메모 ${secret} 카드 4111-1111-1111-1111`,
      source: { kind: 'chat' },
    });

    expect(fact.text).not.toContain(secret);
    expect(fact.text).not.toContain('4111-1111-1111-1111');
    expect(fact.text).toContain('[masked]');
    expect(maskSecrets('짧은 memo')).toBe('짧은 memo');
  });
});

describe('tokens and person keys', () => {
  it('strips Korean particles from token ends', () => {
    expect(tokenize('민수님이랑 커피는 주말에는')).toEqual(['민수', '커피', '주말']);
  });

  it('normalizes honorifics, particles and English prefixes', () => {
    expect(personKey('민수님이랑')).toBe('민수');
    expect(personKey('지은 씨')).toBe('지은');
    expect(personKey('Mr. Kim')).toBe('kim');
    expect(personKey('Minsu@Example.com')).toBe('minsu@example.com');
    expect(personKey('민수 <minsu@example.com>')).toBe('minsu@example.com');
  });
});
