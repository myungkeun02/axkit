import { describe, expect, it } from 'vitest';
import { AsideWebAgent, cartIn, promptFor } from '../../../src/connectors/aside/agent.js';
import type { WebAgent, WebRunInput, WebRunResult } from '../../../src/core/contracts/web-agent.js';
import { PendingCarts } from '../../../src/skills/ways/pay.js';
import { WaysStore } from '../../../src/skills/ways/store.js';
import { wayTools } from '../../../src/skills/ways/tools.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const NOW = new Date('2026-11-25T12:00:00+09:00');

function tools(results: WebRunResult[]) {
  const runs: WebRunInput[] = [];
  const agent: WebAgent = { label: 'fake', run: async (input) => (runs.push(input), results.shift() ?? { ok: true, answer: '' }) };
  const list = wayTools({ store: new WaysStore(new MapKeyValueStore()), agent: () => agent, clock: { now: () => NOW } as never, korean: true, carts: new PendingCarts() });
  const get = (name: string) => list.find((tool) => tool.name === name)!;
  return { runs, get };
}

describe('paying after the owner approves the amount', () => {
  it('reads the cart line after PAYMENT_STEP and puts the sign-in and payment rules in the prompts', () => {
    expect(cartIn('장바구니에 담았어요. PAYMENT_STEP {"items":"A4 용지 2박스","total":"24,000","method":"토스페이"}')).toEqual({ items: 'A4 용지 2박스', total: 24000, method: '토스페이' });
    expect(cartIn('PAYMENT_STEP 합계 모름')).toBeUndefined();
    expect(promptFor({ task: 't', mode: 'do' })).toContain('saved');
    const pay = promptFor({ task: 't', mode: 'pay', payment: { items: 'A4 2박스', total: 24000 } });
    expect(pay).toContain('exactly 24000 won');
    expect(pay).toContain('TOTAL_CHANGED');
    expect(pay).toContain('never type card numbers');
  });

  it('web.do stops at checkout with the cart; web.pay is a pay-effect tool that pays only that exact total', async () => {
    const cart = { items: 'A4 용지 2박스', total: 24000, method: '토스페이' };
    const { runs, get } = tools([
      { ok: false, answer: 'PAYMENT_STEP', stopped: 'payment', cart },
      { ok: true, answer: '주문번호 123, 24,000원 결제했어요.' },
    ]);
    const done = (await get('web.do').run({ task: '쿠팡에서 A4 2박스 주문', site: 'coupang.com' }, { call: { grounding: [] } } as never)) as { cart: unknown; note: string };
    expect(done.cart).toEqual(cart);
    expect(done.note).toContain('합계 24,000원');
    const pay = get('web.pay');
    expect(pay.effects).toEqual(['pay']);
    expect(pay.describe?.({ site: 'coupang.com', total: 24000 } as never)).toBe('결제: coupang.com에서 24,000원 — A4 용지 2박스 (토스페이)');
    await expect(pay.run({ site: 'coupang.com', total: 25000 }, {} as never)).rejects.toThrow('장바구니를 다시 확인');
    expect(await pay.run({ site: 'coupang.com', total: 24000 }, {} as never)).toMatchObject({ ok: true, paid: 24000 });
    expect(runs[1]).toMatchObject({ mode: 'pay', site: 'coupang.com', payment: cart });
    await expect(pay.run({ site: 'coupang.com', total: 24000 }, {} as never)).rejects.toThrow();
  });

  it('a pay run that finds a different total pays nothing', async () => {
    const agent = new AsideWebAgent({ command: 'a', run: async () => ({ code: 0, stdout: '{"outcome":"completed","answer":"TOTAL_CHANGED 26,000원"}', stderr: '', timedOut: false }), defaultTimeoutMinutes: 5 });
    expect(await agent.run({ task: 't', mode: 'pay', payment: { items: 'x', total: 24000 } })).toMatchObject({ ok: false, stopped: 'changed' });
  });

  it('a login stop sends the owner to the remote browser, and that site then goes through browser.task', async () => {
    const { runs, get } = tools([{ ok: false, answer: 'LOGIN_NEEDED', stopped: 'login' }]);
    const first = (await get('web.look').run({ task: '주문 내역 보기', site: 'shop.example.com' }, {} as never)) as { note: string };
    expect(first.note).toContain('browser.open_for_me');
    const second = (await get('web.look').run({ task: '주문 내역 보기', site: 'shop.example.com' }, {} as never)) as { useBrowser: boolean; note: string };
    expect(second).toMatchObject({ useBrowser: true });
    expect(second.note).toContain('browser.task');
    expect(runs).toHaveLength(1);
  });
});
