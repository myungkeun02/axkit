import { describe, expect, it } from 'vitest';
import { FakePrices, addWatchId, at, setup, storedWatches, sweep } from './helpers.js';

describe('watch.sweep', () => {
  it('backs off on failures and sends one failing notice at three in a row', async () => {
    const prices = new FakePrices();
    prices.fail = true;
    const context = await setup({ prices });
    const id = await addWatchId(context, { kind: 'price', query: '무선 이어폰', everyMinutes: 30 });

    await sweep(context, at(context, 0));
    let watch = (await storedWatches(context)).find((candidate) => candidate.id === id);
    expect(watch?.failures).toBe(1);
    expect(watch?.nextAt).toBe(at(context, 60).toISOString());
    expect(prices.calls).toHaveLength(1);

    await sweep(context, at(context, 30));
    expect(prices.calls).toHaveLength(1);

    await sweep(context, at(context, 61));
    watch = (await storedWatches(context)).find((candidate) => candidate.id === id);
    expect(watch?.failures).toBe(2);
    expect(watch?.nextAt).toBe(at(context, 181).toISOString());
    expect(context.notifier.notices).toHaveLength(0);

    await sweep(context, at(context, 181));
    watch = (await storedWatches(context)).find((candidate) => candidate.id === id);
    expect(watch?.failures).toBe(3);
    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]?.kind).toBe('watch.failing');
    expect(context.notifier.notices[0]?.text).toContain('확인이 안 돼요');

    await sweep(context, at(context, 422));
    watch = (await storedWatches(context)).find((candidate) => candidate.id === id);
    expect(watch?.failures).toBe(4);
    expect(context.notifier.notices).toHaveLength(1);
  });

  it('caps backoff at 24 hours', async () => {
    const prices = new FakePrices();
    prices.fail = true;
    const context = await setup({ prices });
    const id = await addWatchId(context, { kind: 'price', query: '무선 이어폰', everyMinutes: 10_080 });

    await sweep(context, at(context, 0));

    const watch = (await storedWatches(context)).find((candidate) => candidate.id === id);
    expect(watch?.nextAt).toBe(at(context, 24 * 60).toISOString());
  });

  it('checks at most five due watches per sweep', async () => {
    const prices = new FakePrices();
    prices.offers = [{ title: '무선 이어폰', priceKrw: 60_000, mall: '예시몰', url: 'https://shop.example.com/1' }];
    const context = await setup({ prices });
    for (let index = 0; index < 6; index += 1) {
      await addWatchId(context, { kind: 'price', query: `무선 이어폰 ${index}`, everyMinutes: 30 });
    }

    await sweep(context, at(context, 0));

    expect(prices.calls).toHaveLength(5);
    const watches = await storedWatches(context);
    const dueLater = watches.filter((watch) => watch.nextAt === at(context, 30).toISOString());
    const stillDue = watches.filter((watch) => watch.nextAt === at(context, 0).toISOString());
    expect(dueLater).toHaveLength(5);
    expect(stillDue).toHaveLength(1);
  });

  it('resets the failure count after a success', async () => {
    const prices = new FakePrices();
    prices.fail = true;
    const context = await setup({ prices });
    const id = await addWatchId(context, { kind: 'price', query: '무선 이어폰', everyMinutes: 30 });

    await sweep(context, at(context, 0));
    prices.fail = false;
    prices.offers = [{ title: '무선 이어폰', priceKrw: 60_000, mall: '예시몰', url: 'https://shop.example.com/1' }];
    await sweep(context, at(context, 61));

    const watch = (await storedWatches(context)).find((candidate) => candidate.id === id);
    expect(watch?.failures).toBe(0);
    expect(watch?.last?.price).toBe(60_000);
  });
});
