import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakePages, FakePrices, addWatchId, at, setup, storedWatch, sweep } from './helpers.js';

const OFFER = {
  title: '무선 이어폰',
  priceKrw: 60_000,
  mall: '예시몰',
  url: 'https://shop.example.com/item/1',
};

describe('price watches', () => {
  it('records a baseline without a notice and needs a target crossing or a 5% drop', async () => {
    const prices = new FakePrices();
    prices.offers = [OFFER];
    const context = await setup({ prices });
    const id = await addWatchId(context, {
      kind: 'price',
      query: '무선 이어폰',
      targetPrice: 50_000,
      everyMinutes: 30,
    });

    await sweep(context, at(context, 0));
    expect(context.notifier.notices).toHaveLength(0);
    expect((await storedWatch(context, id))?.last?.price).toBe(60_000);

    prices.offers = [{ ...OFFER, priceKrw: 58_000 }];
    await sweep(context, at(context, 31));
    expect(context.notifier.notices).toHaveLength(0);

    prices.offers = [{ ...OFFER, priceKrw: 45_000 }];
    await sweep(context, at(context, 62));
    expect(context.notifier.notices).toHaveLength(1);
    const notice = context.notifier.notices[0];
    expect(notice?.kind).toBe('watch.alert');
    expect(notice?.dedupeKey).toBe(`${id}:45000`);
    expect(notice?.text).toContain('58,000원 → 45,000원');
    expect(notice?.text).toContain('예시몰');
    expect(notice?.text).toContain(OFFER.url);
    expect(notice?.text).toContain('목표가 50,000원');
  });

  it('notifies on the first check when the price is already at the target', async () => {
    const prices = new FakePrices();
    prices.offers = [{ ...OFFER, priceKrw: 40_000 }];
    const context = await setup({ prices });
    await addWatchId(context, { kind: 'price', query: '무선 이어폰', targetPrice: 50_000 });

    await sweep(context, at(context, 0));

    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]?.text).toContain('지금 40,000원');
  });

  it('offers a cart only when the errands skill can fill one, and only for a reached target', async () => {
    const prices = new FakePrices();
    prices.offers = [{ ...OFFER, priceKrw: 40_000 }];
    const plain = await setup({ prices });
    await addWatchId(plain, { kind: 'price', query: '무선 이어폰', targetPrice: 50_000 });
    await sweep(plain, at(plain, 0));
    expect(plain.notifier.notices[0]?.text).not.toContain('장바구니');

    const context = await setup({ prices });
    context.ctx.registerTool({
      name: 'errands.shop',
      description: 'fake',
      input: z.object({}),
      effects: ['send'],
      run: async () => ({}),
    });
    await addWatchId(context, { kind: 'price', query: '무선 이어폰', targetPrice: 50_000 });
    await sweep(context, at(context, 0));
    expect(context.notifier.notices[0]?.text).toContain('장바구니에 담아 둘까요?');
    expect(context.notifier.notices[0]?.text).toContain('주문·결제는 직접');
  });

  it('notifies on a drop of 5% or more', async () => {
    const prices = new FakePrices();
    prices.offers = [{ ...OFFER, priceKrw: 100_000 }];
    const context = await setup({ prices });
    await addWatchId(context, { kind: 'price', query: '무선 이어폰', everyMinutes: 30 });

    await sweep(context, at(context, 0));
    prices.offers = [{ ...OFFER, priceKrw: 96_000 }];
    await sweep(context, at(context, 31));
    expect(context.notifier.notices).toHaveLength(0);

    prices.offers = [{ ...OFFER, priceKrw: 90_000 }];
    await sweep(context, at(context, 62));
    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]?.text).toContain('96,000원 → 90,000원');
  });

  it('reads a price from a page URL', async () => {
    const pages = new FakePages();
    const url = 'https://shop.example.com/item/2';
    pages.pages.set(url, '무선 이어폰\n판매가 12,900원\n정가 19,000원');
    const context = await setup({ pages });
    const id = await addWatchId(context, { kind: 'price', url, everyMinutes: 30 });

    await sweep(context, at(context, 0));
    expect(context.notifier.notices).toHaveLength(0);
    expect((await storedWatch(context, id))?.last).toMatchObject({
      price: 12_900,
      mall: 'shop.example.com',
      offerUrl: url,
    });

    pages.pages.set(url, '무선 이어폰\n판매가 11,900원');
    await sweep(context, at(context, 31));
    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]?.text).toContain('12,900원 → 11,900원');
  });

  it('treats a page with no price as a failed check', async () => {
    const pages = new FakePages();
    const url = 'https://shop.example.com/item/3';
    pages.pages.set(url, '가격 정보가 없어요');
    const context = await setup({ pages });
    const id = await addWatchId(context, { kind: 'price', url, everyMinutes: 30 });

    await sweep(context, at(context, 0));

    expect((await storedWatch(context, id))?.failures).toBe(1);
    expect(context.notifier.notices).toHaveLength(0);
  });
});

describe('restock watches', () => {
  it('notifies only on out-of-stock to in-stock', async () => {
    const pages = new FakePages();
    const url = 'https://shop.example.com/item/4';
    pages.pages.set(url, '품절');
    const context = await setup({ pages });
    const id = await addWatchId(context, { kind: 'restock', url, everyMinutes: 30 });

    await sweep(context, at(context, 0));
    expect(context.notifier.notices).toHaveLength(0);
    expect((await storedWatch(context, id))?.last?.inStock).toBe(false);

    await sweep(context, at(context, 31));
    expect(context.notifier.notices).toHaveLength(0);

    pages.pages.set(url, '구매 가능');
    await sweep(context, at(context, 62));
    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]?.dedupeKey).toBe(`${id}:in-stock`);
    expect(context.notifier.notices[0]?.text).toContain('다시 살 수 있게 됐어요');
    expect((await storedWatch(context, id))?.last?.inStock).toBe(true);

    await sweep(context, at(context, 93));
    expect(context.notifier.notices).toHaveLength(1);
  });
});

describe('page watches', () => {
  it('notifies with up to three added lines and ignores date stamps', async () => {
    const pages = new FakePages();
    const url = 'https://shop.example.com/notice';
    pages.pages.set(url, '첫 줄\n둘째 줄');
    const context = await setup({ pages });
    const id = await addWatchId(context, { kind: 'page', url, everyMinutes: 30 });

    await sweep(context, at(context, 0));
    expect(context.notifier.notices).toHaveLength(0);
    expect((await storedWatch(context, id))?.last?.lines).toEqual(['첫 줄', '둘째 줄']);

    pages.pages.set(url, '첫 줄\n둘째 줄\n새 소식\n2026-11-17\n09:30');
    await sweep(context, at(context, 31));

    expect(context.notifier.notices).toHaveLength(1);
    const notice = context.notifier.notices[0];
    expect(notice?.text).toContain('> 새 소식');
    expect(notice?.text).not.toContain('2026-11-17');
    expect(notice?.dedupeKey?.startsWith(`${id}:`)).toBe(true);
  });

  it('does not notify when the page is unchanged', async () => {
    const pages = new FakePages();
    const url = 'https://shop.example.com/notice';
    pages.pages.set(url, '그대로');
    const context = await setup({ pages });
    await addWatchId(context, { kind: 'page', url, everyMinutes: 30 });

    await sweep(context, at(context, 0));
    await sweep(context, at(context, 31));
    expect(context.notifier.notices).toHaveLength(0);
  });
});

describe('missing capabilities', () => {
  it('skips silently and keeps a price watch due', async () => {
    const context = await setup();
    const id = await addWatchId(context, { kind: 'price', query: '무선 이어폰', everyMinutes: 30 });
    const before = await storedWatch(context, id);

    await sweep(context, at(context, 0));

    const after = await storedWatch(context, id);
    expect(context.notifier.notices).toHaveLength(0);
    expect(after?.failures).toBe(0);
    expect(after?.nextAt).toBe(before?.nextAt);
  });

  it('returns skipped from check_now', async () => {
    const context = await setup();
    const id = await addWatchId(context, { kind: 'page', url: 'https://shop.example.com/p', everyMinutes: 30 });

    const outcome = await context.ctx.tools.execute('watch.check_now', { id });

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? outcome.output : undefined).toMatchObject({ status: 'skipped' });
  });
});
