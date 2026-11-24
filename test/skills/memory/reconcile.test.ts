import { describe, expect, it } from 'vitest';
import type { LlmGateway, LlmRequest } from '../../../src/core/llm/types.js';
import { FactStore } from '../../../src/skills/memory/facts.js';
import { reconcileFacts } from '../../../src/skills/memory/reconcile.js';
import { createTestContext } from '../../support/context.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';

function model(answer: unknown, seen: LlmRequest[] = []): LlmGateway {
  return {
    async complete(request) {
      seen.push(request);
      return { text: JSON.stringify(answer), providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  } as LlmGateway;
}

describe('memory cleanup', () => {
  it('folds a near-duplicate into the existing fact when it is written', async () => {
    const clock = new FakeClock(new Date('2026-11-20T00:00:00Z'));
    const store = new FactStore(new MapKeyValueStore(), () => clock.now());
    await store.remember({ subject: 'owner', text: '오전에는 거래처 통화가 어려움', source: { kind: 'chat' } });
    await clock.advance(86_400_000);
    await store.remember({ subject: 'owner', text: '오전에는 거래처와 통화가 어려움', source: { kind: 'chat' } });
    expect(store.all().map((fact) => fact.text)).toEqual(['오전에는 거래처와 통화가 어려움']);
    await store.remember({ subject: 'owner', text: '점심은 12시 반', source: { kind: 'chat' } });
    expect(store.all()).toHaveLength(2);
  });

  it('merges duplicates and retires a fact a newer one replaced, keeping the owner’s own words', async () => {
    const clock = new FakeClock(new Date('2026-11-01T00:00:00Z'));
    const store = new FactStore(new MapKeyValueStore(), () => clock.now());
    const a = await store.remember({ subject: 'owner', text: '통화는 오후가 편함', source: { kind: 'chat' } });
    const interview = await store.remember({ subject: 'owner', text: '주말에는 연락 안 받음', source: { kind: 'interview', ref: 'q1' } });
    await clock.advance(5 * 86_400_000);
    const b = await store.remember({ subject: 'owner', text: '요즘은 오전 통화가 편함', source: { kind: 'chat' } });
    const c = await store.remember({ subject: 'owner', text: '오후 통화 선호', source: { kind: 'chat' } });
    const d = await store.remember({ subject: 'owner', text: '주말에도 급하면 연락 가능', source: { kind: 'chat' } });
    const ref = (id: string): string => `F${store.all().filter((fact) => fact.expiredAt === undefined).sort((l, r) => r.confirmedAt.localeCompare(l.confirmedAt)).findIndex((fact) => fact.id === id) + 1}`;
    const seen: LlmRequest[] = [];
    const context = createTestContext({ llm: model({ merges: [{ keep: ref(a.id), drop: [ref(c.id)] }], replaced: [{ old: ref(a.id), by: ref(b.id) }, { old: ref(interview.id), by: ref(d.id) }, { old: ref(b.id), by: ref(a.id) }] }, seen) });

    expect(await reconcileFacts(context.ctx, store)).toEqual({ merged: 1, replaced: 1 });
    expect(store.get(c.id)).toBeUndefined();
    expect(store.get(a.id)).toMatchObject({ expiredReason: 'replaced', replacedBy: b.id });
    // the interview answer outranks a chat remark; an older fact never replaces a newer one
    expect(store.get(interview.id)?.expiredAt).toBeUndefined();
    expect(store.get(b.id)?.expiredAt).toBeUndefined();
    expect(seen[0]?.messages.at(-1)?.content).toContain('[interview');
  });
});
