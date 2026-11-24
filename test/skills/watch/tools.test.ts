import { describe, expect, it } from 'vitest';
import type { NoticeResult, Notifier } from '../../../src/core/contracts/index.js';
import type { FakeConfirmer } from '../../support/context.js';
import type { WatchAddOutput } from '../../../src/skills/watch/tool-add.js';
import { FakePrices, addWatchId, at, setup, storedWatches, sweep } from './helpers.js';

const OFFER = { title: '무선 이어폰', priceKrw: 60_000, mall: '예시몰', url: 'https://shop.example.com/1' };

describe('watch tools', () => {
  it('adds a watch and returns it with the next check in the owner zone', async () => {
    const prices = new FakePrices();
    const context = await setup({ prices });

    const outcome = await context.ctx.tools.execute('watch.add', {
      kind: 'price',
      query: '무선 이어폰',
      targetPrice: 50_000,
    });

    if (outcome.status !== 'done') throw new Error(`watch.add failed: ${outcome.status}`);
    const output = outcome.output as WatchAddOutput;
    expect(output.status).toBe('ok');
    if (output.status !== 'ok') return;
    expect(output.watch).toMatchObject({
      kind: 'price',
      label: '무선 이어폰',
      condition: '50,000원 이하가 되면',
      nextCheck: '2026-11-17 09:00',
      last: null,
    });
    expect((await storedWatches(context)).map((watch) => watch.id)).toEqual([output.watch.id]);
  });

  it('rejects malformed add inputs', async () => {
    const context = await setup();
    const invalid = [
      { kind: 'price' },
      { kind: 'price', query: '무선 이어폰', url: 'https://shop.example.com/1' },
      { kind: 'restock' },
      { kind: 'page', query: '무선 이어폰', url: 'https://shop.example.com/1' },
      { kind: 'restock', url: 'ftp://shop.example.com/1' },
      { kind: 'price', query: '무선 이어폰', everyMinutes: 10 },
      { kind: 'restock', url: 'https://shop.example.com/1', targetPrice: 1000 },
    ];

    for (const input of invalid) {
      const outcome = await context.ctx.tools.execute('watch.add', input);
      expect(outcome.status).toBe('invalid_input');
    }
  });

  it('lists watches', async () => {
    const context = await setup();
    await addWatchId(context, { kind: 'restock', url: 'https://shop.example.com/1', label: '이어폰 재입고' });
    await addWatchId(context, { kind: 'page', url: 'https://shop.example.com/notice', everyMinutes: 60 });

    const outcome = await context.ctx.tools.execute('watch.list', {});

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? outcome.output : undefined).toMatchObject({
      count: 2,
      message: '지켜보는 중 2개',
    });
  });

  it('asks the confirmer before removing a watch', async () => {
    const context = await setup();
    const id = await addWatchId(context, { kind: 'page', url: 'https://shop.example.com/notice', label: '공지' });

    const outcome = await context.ctx.tools.execute('watch.remove', { id });

    expect(outcome.status).toBe('done');
    const confirmer = context.confirmer as FakeConfirmer;
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.summary).toContain('공지');
    expect(await storedWatches(context)).toHaveLength(0);
  });

  it('does not remove when the owner denies', async () => {
    const context = await setup();
    const id = await addWatchId(context, { kind: 'page', url: 'https://shop.example.com/notice' });
    (context.confirmer as FakeConfirmer).answer = 'denied';

    const outcome = await context.ctx.tools.execute('watch.remove', { id });

    expect(outcome.status).toBe('denied');
    expect(await storedWatches(context)).toHaveLength(1);
  });

  it('checks now and sends the alert the sweep would send', async () => {
    const prices = new FakePrices();
    prices.offers = [OFFER];
    const context = await setup({ prices });
    const id = await addWatchId(context, { kind: 'price', query: '무선 이어폰', targetPrice: 50_000, everyMinutes: 30 });
    await sweep(context, at(context, 0));

    prices.offers = [{ ...OFFER, priceKrw: 45_000 }];
    const outcome = await context.ctx.tools.execute('watch.check_now', { id });

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? outcome.output : undefined).toMatchObject({
      status: 'ok',
      notified: true,
    });
    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]?.kind).toBe('watch.alert');
  });

  it('returns not_found for an unknown id', async () => {
    const context = await setup();

    const outcome = await context.ctx.tools.execute('watch.check_now', { id: 'w_missing' });

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? outcome.output : undefined).toMatchObject({ status: 'not_found' });
  });

  it('swallows a failing notifier', async () => {
    class BrokenNotifier implements Notifier {
      async notify(): Promise<NoticeResult> {
        throw new Error('discord down');
      }
    }
    const prices = new FakePrices();
    prices.offers = [{ ...OFFER, priceKrw: 40_000 }];
    const context = await setup({ prices, notifier: new BrokenNotifier() });
    await addWatchId(context, { kind: 'price', query: '무선 이어폰', targetPrice: 50_000 });

    await sweep(context, at(context, 0));

    const watches = await storedWatches(context);
    expect(watches[0]?.failures).toBe(0);
    expect(watches[0]?.last?.price).toBe(40_000);
  });
});
