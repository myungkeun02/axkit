import { describe, expect, it } from 'vitest';
import type { BrowserRunResult, BrowserTask } from '../../../src/core/contracts/index.js';
import { judgeAction } from '../../../src/connectors/browser/harness/policy.js';
import type { PageElement } from '../../../src/connectors/browser/harness/types.js';
import type { ErrandOutput } from '../../../src/skills/errands/types.js';
import { TABLE, TRAIN, setup } from './helpers.js';
import type { ErrandsTestContext } from './helpers.js';

/**
 * A browser that tries to press every button on a scripted page in order, through the real harness policy. It
 * shows what the errands let through: payment and final buttons are never pressed unless the one approved seat
 * button is named, and payment never.
 */
function scriptedPage(context: ErrandsTestContext, buttons: readonly string[]): string[] {
  const pressed: string[] = [];
  context.agent.run = async (task: BrowserTask): Promise<BrowserRunResult> => {
    context.agent.tasks.push(task);
    const policy = {
      allowedDomains: ['letskorail.com', 'naver.com', 'coupang.com'],
      ...(task.approvedCommit !== undefined ? { approvedCommit: task.approvedCommit } : {}),
    };
    for (const [ref, name] of buttons.entries()) {
      const element: PageElement = { ref, role: 'button', name, disabled: false, secret: false, nth: 0 };
      const verdict = judgeAction({ kind: 'click', ref }, element, policy);
      if (verdict.kind === 'handoff') {
        const handoff = { reason: verdict.reason, url: task.startUrl ?? '', ...(verdict.button !== undefined ? { button: verdict.button } : {}) };
        return { status: 'needs_human', summary: verdict.note, url: task.startUrl ?? '', handoff };
      }
      pressed.push(name);
    }
    return { status: 'done', summary: 'ADDED: yes', url: task.startUrl ?? '' };
  };
  return pressed;
}

async function errand(context: ErrandsTestContext, tool: string, input: unknown): Promise<ErrandOutput> {
  const outcome = await context.ctx.tools.execute(tool, input);
  if (outcome.status !== 'done') throw new Error(outcome.status);
  return context.settled.next<ErrandOutput>();
}

const PAY = /결제|구매|주문|pay/i;

describe('errand stop rules through the browser policy', () => {
  it('a train stops at 예매; with the owner’s yes it holds the seat and still stops at 결제하기', async () => {
    const context = await setup();
    const page = ['조회하기', 'KTX 015 08:30 선택', '예매', '결제하기'];
    const pressed = scriptedPage(context, page);
    const first = await errand(context, 'errands.train', TRAIN);
    expect(first.handoff).toMatchObject({ reason: 'other', button: '예매' });
    expect(pressed).toEqual(['조회하기', 'KTX 015 08:30 선택']);

    pressed.length = 0;
    const held = await errand(context, 'errands.train', { ...TRAIN, approvedButton: '예매' });
    expect(pressed).toEqual(['조회하기', 'KTX 015 08:30 선택', '예매']);
    expect(held.handoff?.reason).toBe('payment');
    expect(pressed.some((name) => PAY.test(name))).toBe(false);
  });

  it('a restaurant never presses 예약하기 or 예약 확정', async () => {
    const context = await setup();
    for (const finalButton of ['예약하기', '예약 확정', 'Book now']) {
      const pressed = scriptedPage(context, ['11월 28일', '19:00', '4명', finalButton]);
      const output = await errand(context, 'errands.restaurant', TABLE);
      expect(pressed).toEqual(['11월 28일', '19:00', '4명']);
      expect(output.committed).toBe(false);
      expect(output.handoff?.reason).toBe('other');
    }
  });

  it('shopping fills the cart and stops at 구매하기 / 주문하기', async () => {
    const context = await setup();
    for (const buy of ['구매하기', '주문하기', '바로구매', 'Checkout']) {
      const pressed = scriptedPage(context, ['수량 +', '장바구니 담기', '장바구니 보기', buy]);
      const output = await errand(context, 'errands.shop', { product: '이어폰', url: 'https://www.coupang.com/vp/products/1' });
      expect(pressed).toEqual(['수량 +', '장바구니 담기', '장바구니 보기']);
      expect(output).toMatchObject({ status: 'ready', handoff: { reason: 'payment' } });
    }
  });

  it('the policy treats a bare 예매 as a final button, not a menu like 승차권예매', () => {
    const policy = { allowedDomains: ['letskorail.com'] };
    const click = (name: string) =>
      judgeAction({ kind: 'click', ref: 0 }, { ref: 0, role: 'button', name, disabled: false, secret: false, nth: 0 }, policy);
    expect(click(' 예매 ')).toMatchObject({ kind: 'handoff', reason: 'other', button: '예매' });
    expect(click('승차권예매')).toEqual({ kind: 'allow' });
    expect(judgeAction({ kind: 'click', ref: 0 }, { ref: 0, role: 'button', name: '결제하기', disabled: false, secret: false, nth: 0 }, { ...policy, approvedCommit: '결제하기' })).toMatchObject({ kind: 'handoff', reason: 'payment' });
  });
});
