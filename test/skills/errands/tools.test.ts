import { describe, expect, it } from 'vitest';
import type { ErrandOutput } from '../../../src/skills/errands/types.js';
import { TABLE, TRAIN, setup } from './helpers.js';
import type { ErrandsTestContext } from './helpers.js';

async function errand(context: ErrandsTestContext, tool: string, input: unknown): Promise<ErrandOutput> {
  const outcome = await context.ctx.tools.execute(tool, input, { grounding: [], conversation: { channelId: 'channel.app', address: 'owner' } });
  if (outcome.status !== 'done') throw new Error(`${tool}: ${outcome.status} ${JSON.stringify(outcome)}`);
  return context.settled.next<ErrandOutput>();
}

const stopAtButton = (summary: string, button: string, url = 'https://www.letskorail.com/book') => ({
  status: 'needs_human' as const,
  summary,
  url,
  handoff: { reason: 'other' as const, url, button },
});

describe('errand cards', () => {
  it('asks on a card with what will be booked, every time, and runs nothing after a no', async () => {
    const context = await setup({ answer: 'denied' });
    const outcome = await context.ctx.tools.execute('errands.train', TRAIN);
    expect(outcome.status).toBe('denied');
    expect(context.agent.tasks).toHaveLength(0);
    const card = context.confirmer.requests[0];
    expect(card?.summary).toContain('코레일(KTX) 서울 → 부산, 2026-11-28 08:00 이후, 어른 2, 일반실');
    expect(card?.summary).toContain('고르는 기준: 가장 빨리 도착하는 것');
    expect(card?.summary).toContain('예매 버튼 바로 앞에서 멈춰요');
    // a note means the card is always shown and never offers "from now on, just do it"
    expect(card?.note).toContain('매번 여쭤봐요');
    expect(card?.remember).toBeUndefined();
  });

  it('cards the restaurant and the cart with their stop points', async () => {
    const context = await setup();
    context.agent.results = [stopAtButton('DEPOSIT: none; CANCEL: 하루 전까지 무료 취소', '예약하기', 'https://booking.naver.com/x')];
    await errand(context, 'errands.restaurant', TABLE);
    context.agent.results = [{ status: 'done', summary: 'ADDED: yes', url: 'https://www.coupang.com/cart' }];
    await errand(context, 'errands.shop', { product: '무선 이어폰', url: 'https://www.coupang.com/vp/products/1' });
    const [table, cart] = context.confirmer.requests;
    expect(table?.summary).toContain('을지로 스시 하루, 2026-11-28 19:00, 4명');
    expect(table?.summary).toContain('[예약하기] 바로 앞에서 멈춰요');
    expect(cart?.summary).toContain('장바구니에 담는 데까지만');
    expect(cart?.note).toContain('매번 여쭤봐요');
  });

  it('refuses a date that already passed', async () => {
    const context = await setup();
    const outcome = await context.ctx.tools.execute('errands.train', { ...TRAIN, date: '2026-11-20' });
    expect(outcome.status).toBe('rejected');
    expect(context.agent.tasks).toHaveLength(0);
  });
});

describe('train errand', () => {
  it('stops before 예매 and tells the owner exactly what to press', async () => {
    const context = await setup();
    context.agent.results = [stopAtButton('TRAIN: KTX 015; DEPART: 08:30; ARRIVE: 11:05; SEAT: 일반실 5호차; PRICE: 119,600원', '예매')];
    const output = await errand(context, 'errands.train', TRAIN);

    const task = context.agent.tasks[0];
    expect(task?.startUrl).toBe('https://www.korail.com/');
    expect(task?.approvedCommit).toBeUndefined();
    expect(task?.goal).toContain('Do NOT press 예매 or any payment button');
    expect(task?.goal).toContain('Never solve a captcha');
    expect(output).toMatchObject({ status: 'ready', committed: false, handoff: { reason: 'other', button: '예매' } });
    expect(output.notice).toContain('· 열차: KTX 015');
    expect(output.notice).toContain("여기서 '예매'를 눌러 주세요.");
    expect(output.liveView).toBeUndefined();
  });

  it('holds the seat only with the owner’s approved button and stops at payment', async () => {
    const context = await setup();
    context.agent.results = [
      { status: 'needs_human', summary: 'DEADLINE: 10분 안에 결제', url: 'https://www.letskorail.com/pay', handoff: { reason: 'payment' } },
    ];
    const output = await errand(context, 'errands.train', { ...TRAIN, approvedButton: '예매' });
    expect(context.agent.tasks[0]?.approvedCommit).toBe('예매');
    expect(context.confirmer.requests[0]?.summary).toContain("'예매' 버튼만 눌러 좌석을 잡고 결제 화면에서 멈춰요");
    expect(output.status).toBe('ready');
    expect(output.handoff?.reason).toBe('payment');
    expect(output.notice).toContain('결제하기를 눌러 직접 결제해 주세요');
  });

  it('never accepts a payment button as the approved one', async () => {
    const context = await setup();
    for (const approvedButton of ['결제하기', '바로 구매', 'Pay now', '주문하기']) {
      const outcome = await context.ctx.tools.execute('errands.train', { ...TRAIN, approvedButton });
      expect(outcome.status).toBe('invalid_input');
    }
    expect(context.agent.tasks).toHaveLength(0);
  });

  it('hands a login to the owner in the app and continues from where it stopped', async () => {
    const context = await setup({ app: true });
    const url = 'https://www.letskorail.com/login';
    context.agent.results = [{ status: 'needs_human', summary: 'login needed', url, handoff: { reason: 'login', url } }];
    const output = await errand(context, 'errands.train', TRAIN);
    expect(context.agent.tasks[0]?.keepPage).toBe(true);
    expect(output.status).toBe('needs_human');
    expect(output.liveView).toBe('browser-live');
    expect(output.handoff?.guide).toContain('맥 화면에서 직접 로그인해 주세요.');
    expect(context.live?.offers).toEqual([{ url, reason: 'login', origin: { channelId: 'channel.app', address: 'owner' } }]);

    context.agent.results = [stopAtButton('TRAIN: KTX 015', '예매')];
    await errand(context, 'errands.train', { ...TRAIN, continueUrl: url });
    expect(context.agent.tasks[1]?.startUrl).toBe(url);
  });

  it('says when no seat is left and offers the low-frequency watch', async () => {
    const context = await setup();
    context.agent.results = [{ status: 'done', summary: 'SEATS: no' }];
    const output = await errand(context, 'errands.train', { ...TRAIN, operator: 'srt', from: '수서' });
    expect(context.agent.tasks[0]?.startUrl).toBe('https://etk.srail.kr/');
    expect(output.status).toBe('not_found');
    expect(output.handoff).toBeUndefined();
    expect(output.notice).toContain('10~15분에 한 번만');
  });

  it('warns the owner when a page looks committed although nothing was approved', async () => {
    const context = await setup();
    context.agent.results = [{ status: 'done', summary: '예매가 완료되었습니다. SEATS: yes' }];
    const output = await errand(context, 'errands.train', TRAIN);
    expect(output.committed).toBe(false);
    expect(output.notice).toContain('예약·주문 내역을 바로 확인해 주세요');
  });
});

describe('restaurant errand', () => {
  const url = 'https://booking.naver.com/booking/6/bizes/1';

  it('is ready before 예약하기 only with no deposit and a clear cancellation rule', async () => {
    const context = await setup();
    context.agent.results = [stopAtButton('PLACE: 스시 하루; DEPOSIT: 없음; CANCEL: 전날까지 무료 취소', '예약하기', url)];
    const output = await errand(context, 'errands.restaurant', { ...TABLE, url });
    expect(context.agent.tasks[0]?.startUrl).toBe(url);
    expect(context.agent.tasks[0]?.goal).toContain('Do NOT press the final reservation button');
    expect(output).toMatchObject({ status: 'ready', handoff: { reason: 'other', button: '예약하기' } });
    expect(output.notice).toContain("여기서 '예약하기'를 눌러 주세요.");
  });

  it('asks about a deposit instead of offering to press anything', async () => {
    const context = await setup();
    context.agent.results = [stopAtButton('DEPOSIT: 1인 10,000원; CANCEL: 3일 전까지 환불', '예약하기', url)];
    const output = await errand(context, 'errands.restaurant', TABLE);
    expect(context.agent.tasks[0]?.startUrl).toBe('https://map.naver.com/');
    expect(output.status).toBe('ask');
    expect(output.handoff?.button).toBeUndefined();
    expect(output.notice).toContain('예약금(선결제)이 있어서 멈췄어요');
  });

  it('treats a payment screen on the way as a deposit, and a missing rule as unclear', async () => {
    const context = await setup();
    context.agent.results = [{ status: 'needs_human', summary: '예약 진행', url, handoff: { reason: 'payment', url } }];
    expect((await errand(context, 'errands.restaurant', TABLE)).status).toBe('ask');

    context.agent.results = [stopAtButton('PLACE: 스시 하루; DEPOSIT: none', '예약하기', url)];
    const unclear = await errand(context, 'errands.restaurant', { ...TABLE, site: 'catchtable' });
    expect(context.agent.tasks[1]?.startUrl).toBe('https://app.catchtable.co.kr/');
    expect(unclear.status).toBe('ask');
    expect(unclear.notice).toContain('취소 규정이 분명하지 않아서 멈췄어요');
    expect(unclear.handoff?.button).toBeUndefined();
  });

  it('reports other times when the slot is full', async () => {
    const context = await setup();
    context.agent.results = [{ status: 'done', summary: 'AVAILABLE: no; OTHER_TIMES: 18:00, 20:30' }];
    const output = await errand(context, 'errands.restaurant', TABLE);
    expect(output.status).toBe('not_found');
    expect(output.notice).toContain('18:00, 20:30');
  });
});

describe('shopping errand', () => {
  it('stops at the cart and hands ordering and payment to the owner', async () => {
    const context = await setup({ app: true });
    context.agent.results = [
      {
        status: 'done',
        summary: 'ITEM: 무선 이어폰 X; OPTIONS: 블랙; QUANTITY: 2; PRICE: 98,000원; DELIVERY: 무료, 내일 도착; ADDED: yes',
        url: 'https://cart.coupang.com/cartView.pang',
      },
    ];
    const output = await errand(context, 'errands.shop', { product: '무선 이어폰 X', quantity: 2, options: ['색상: 블랙'], site: 'coupang.com' });
    const goal = context.agent.tasks[0]?.goal ?? '';
    expect(context.agent.tasks[0]?.startUrl).toBe('https://coupang.com/');
    expect(goal).toContain('Never press 구매하기, 바로구매, 주문하기, 결제 or checkout');
    expect(output).toMatchObject({ status: 'ready', committed: false, handoff: { reason: 'payment' }, liveView: 'browser-live' });
    expect(output.notice).toContain('· 배송: 무료, 내일 도착');
    expect(output.notice).toContain('주문·결제는 직접 해 주세요');
    expect(context.live?.offers[0]).toMatchObject({ url: 'https://cart.coupang.com/cartView.pang', reason: 'payment' });
  });

  it('needs a product page or a store site, and stops to ask about an unclear option', async () => {
    const context = await setup();
    expect((await context.ctx.tools.execute('errands.shop', { product: '이어폰' })).status).toBe('invalid_input');
    context.agent.results = [stopAtButton('OPTIONS: 화이트, 실버', '옵션 선택', 'https://www.coupang.com/vp/products/1')];
    const output = await errand(context, 'errands.shop', { product: '이어폰', options: ['색상: 블랙'], url: 'https://www.coupang.com/vp/products/1' });
    expect(output.status).toBe('ask');
    expect(output.notice).toContain('옵션');
  });

  it('does not add an item over the owner’s price cap', async () => {
    const context = await setup();
    context.agent.results = [{ status: 'done', summary: 'TOTAL: 120,000원; ADDED: no' }];
    const output = await errand(context, 'errands.shop', { product: '이어폰', maxPrice: 100_000, url: 'https://www.coupang.com/vp/products/1' });
    expect(context.agent.tasks[0]?.goal).toContain('above 100000 KRW');
    expect(output.status).toBe('not_found');
    expect(output.handoff).toBeUndefined();
  });
});
