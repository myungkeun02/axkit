import { describe, expect, it } from 'vitest';
import { FactStore } from '../../../src/skills/memory/facts.js';
import { buildSystemPrompt } from '../../../src/skills/assistant/prompt.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';

const DAY_MS = 86_400_000;

async function createStore() {
  const clock = new FakeClock(new Date('2026-01-01T00:00:00+09:00'));
  const store = new FactStore(new MapKeyValueStore(), () => clock.now());
  await store.load();
  return { clock, store };
}

describe('standing instructions (상시 지시)', () => {
  it('are recalled with every turn whatever the words, first, and never fade', async () => {
    const { clock, store } = await createStore();
    await store.remember({ subject: 'owner', text: '메일은 항상 존댓말로 써 줘', source: { kind: 'chat' }, standing: true });
    await store.remember({ subject: 'owner', text: '커피는 아메리카노', source: { kind: 'chat' } });
    await clock.advance(400 * DAY_MS);
    const facts = await store.recall({ text: '내일 일정 알려줘', limit: 8 });
    expect(facts.map((fact) => fact.text)).toEqual(['메일은 항상 존댓말로 써 줘']);
    expect(facts[0]?.standing).toBe(true);
    expect(facts[0]?.strength).toBe(1);
  });

  it('are capped by size, newest first, and do not use up the regular slots', async () => {
    const { clock, store } = await createStore();
    for (let index = 0; index < 12; index += 1) {
      await store.remember({ subject: 'owner', text: `${index}번 규칙 ${'가'.repeat(150)}`, source: { kind: 'chat' }, standing: true });
      await clock.advance(1_000);
    }
    await store.remember({ subject: 'owner', text: '회의는 오후가 좋음', source: { kind: 'chat' } });
    const facts = await store.recall({ text: '회의 잡아줘', limit: 1 });
    const standing = facts.filter((fact) => fact.standing === true);
    expect(standing.length).toBeLessThan(12);
    expect(standing.reduce((size, fact) => size + fact.text.length, 0)).toBeLessThanOrEqual(1_000);
    expect(standing[0]?.text.startsWith('11번')).toBe(true);
    expect(facts.at(-1)?.text).toBe('회의는 오후가 좋음');
  });

  it('can be taken back by confirming the same fact as not standing', async () => {
    const { store } = await createStore();
    await store.remember({ subject: 'owner', text: '보고서는 항상 표로 정리', source: { kind: 'chat' }, standing: true });
    await store.remember({ subject: 'owner', text: '보고서는 항상 표로 정리', source: { kind: 'chat' }, standing: false });
    expect(await store.recall({ text: '날씨', limit: 5 })).toEqual([]);
  });

  it('show in the system prompt under their own heading', () => {
    const prompt = buildSystemPrompt('T', {
      assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul', tone: 'polite' },
      tools: [],
      now: new Date('2026-01-01T00:00:00Z'),
      facts: [
        { id: '1', subject: 'owner', text: '메일은 존댓말로', source: { kind: 'chat' }, at: '2026-01-01T00:00:00Z', strength: 1, standing: true },
        { id: '2', subject: 'owner', text: '커피는 아메리카노', source: { kind: 'chat' }, at: '2026-01-01T00:00:00Z', strength: 1 },
      ],
    });
    expect(prompt).toContain('## Standing instructions from the owner');
    expect(prompt.indexOf('메일은 존댓말로')).toBeLessThan(prompt.indexOf('## What you remember'));
  });
});
