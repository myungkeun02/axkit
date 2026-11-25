import { z } from 'zod';
import type { WebCart } from '../../core/contracts/web-agent.js';
import { guardText } from '../../core/text/data.js';
import type { Tool } from '../../core/tools/types.js';
import type { WaysDeps } from './tools.js';

const CART_TTL_MS = 30 * 60_000;

/** Carts web.do stopped at, by site: web.pay may only pay one of these, at exactly its total. */
export class PendingCarts {
  private readonly carts = new Map<string, WebCart & { at: number; task: string }>();

  keep(site: string, task: string, cart: WebCart, now: number): void {
    this.carts.set(site, { ...cart, task, at: now });
  }

  peek(site: string): (WebCart & { task: string }) | undefined {
    return this.carts.get(site);
  }

  take(site: string, total: number, now: number): (WebCart & { task: string }) | undefined {
    const cart = this.carts.get(site);
    if (cart === undefined || now - cart.at > CART_TTL_MS || cart.total !== total) return undefined;
    this.carts.delete(site);
    return cart;
  }
}

const payInput = z.object({
  site: z.string().min(3).max(200).describe('The site web.do stopped at (its "site" output).'),
  total: z.number().int().positive().describe('The total web.do reported in "cart.total", exactly.'),
});

const won = (n: number): string => `${n.toLocaleString('ko-KR')}원`;

/**
 * Tool "web.pay": finishes a checkout web.do left at the payment step. Effect "pay": the owner approves this exact
 * cart and total on its own card every time (never remembered, never automatic). Code checks the total against the
 * cart the browser saw; the browser pays only with the payment method the site already saved.
 */
export function payTool(deps: WaysDeps, carts: PendingCarts): Tool<z.infer<typeof payInput>, Record<string, unknown>> {
  const describe = (value: z.infer<typeof payInput>): string => {
    const cart = carts.peek(value.site);
    return deps.korean
      ? `결제: ${value.site}에서 ${won(value.total)}${cart !== undefined ? ` — ${cart.items}${cart.method !== undefined ? ` (${cart.method})` : ''}` : ''}`
      : `Pay ${won(value.total)} on ${value.site}${cart !== undefined ? ` — ${cart.items}` : ''}`;
  };
  return {
    name: 'web.pay',
    description: 'Pay for the cart web.do stopped at (stopped: "payment"), with the site, and the exact total from its cart. The owner approves the amount on a card first.',
    input: payInput,
    effects: ['pay'],
    timeoutMs: 15 * 60_000,
    describe,
    async run(value) {
      const agent = deps.agent();
      if (agent === undefined) throw new Error(deps.korean ? '이 맥에 Aside가 없어요.' : 'No web agent (Aside) on this Mac.');
      const cart = carts.take(value.site, value.total, deps.clock.now().getTime());
      if (cart === undefined) throw new Error(deps.korean ? '결제 직전 장바구니를 다시 확인해야 해요. web.do로 결제 바로 전까지 다시 가 주세요.' : 'No matching cart: run web.do to the payment step again.');
      const result = await agent.run({ task: cart.task, mode: 'pay', site: value.site, payment: { items: cart.items, total: cart.total, ...(cart.method !== undefined ? { method: cart.method } : {}) } });
      const note = result.stopped === 'changed'
        ? deps.korean ? '금액이나 상품이 승인한 것과 달라서 결제하지 않았어요.' : 'The total changed; nothing was paid.'
        : result.stopped === 'card'
          ? deps.korean ? '사이트가 카드 번호 입력을 요구해서 멈췄어요. 저장된 결제수단으로 한 번 직접 결제해 두면 다음부터 할 수 있어요.' : 'The site asks for card details; nothing was paid.'
          : result.stopped === 'login'
            ? deps.korean ? '로그인이 필요해서 멈췄어요. Aside 브라우저에서 한 번 로그인해 두세요.' : 'A login is needed.'
            : !result.ok ? (deps.korean ? '결제를 끝내지 못했어요. 사이트에서 주문 내역을 확인해 주세요.' : 'Payment did not finish; check the orders on the site.') : undefined;
      return { ok: result.ok, paid: result.ok ? cart.total : 0, answer: guardText('web_answer', result.answer), ...(note !== undefined ? { note } : {}) };
    },
  };
}
