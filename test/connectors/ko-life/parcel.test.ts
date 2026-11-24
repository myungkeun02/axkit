import { describe, expect, it } from 'vitest';
import { MissingKeyError } from '../../../src/core/contracts/index.js';
import { KO_SECRETS } from '../../../src/connectors/ko-life/secrets.js';
import { SweetTracker } from '../../../src/connectors/ko-life/sweettracker.js';
import { FakeClock } from '../../core/helpers.js';
import type { MapKeyValueStore } from '../../core/helpers.js';
import { fakeFetch, makeDeps, NOW } from './helpers.js';

const SECRETS = { [KO_SECRETS.sweetTracker]: 'tracker-key' };

const COMPANIES = {
  Company: [
    { Code: '11', Name: '가온택배' },
    { Code: '12', Name: '한빛택배' },
    { Code: '13', Name: '바른택배' },
  ],
};

const TRACKING = {
  status: true,
  complete: true,
  trackingDetails: [
    { timeString: '2026-11-16 18:00', where: '예시터미널', kind: '집화처리' },
    { timeString: '2026-11-17 08:00', where: '예시동', kind: '배송완료' },
  ],
};

function trackerWith(
  handler: Parameters<typeof fakeFetch>[0],
  opts: { secrets?: Record<string, string>; clock?: FakeClock; kv?: MapKeyValueStore } = {},
) {
  const fake = fakeFetch(handler);
  const deps = makeDeps(fake.fetch, {
    secrets: opts.secrets ?? SECRETS,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.kv !== undefined ? { kv: opts.kv } : {}),
  });
  return { tracker: new SweetTracker(deps), calls: fake.calls };
}

describe('SweetTracker.carriers', () => {
  it('caches the carrier list for one day', async () => {
    const clock = new FakeClock(NOW);
    const { tracker, calls } = trackerWith(() => COMPANIES, { clock });

    const first = await tracker.carriers();
    expect(first).toEqual([
      { code: '11', name: '가온택배' },
      { code: '12', name: '한빛택배' },
      { code: '13', name: '바른택배' },
    ]);
    expect(calls).toHaveLength(1);

    await clock.advance(23 * 60 * 60 * 1_000);
    await expect(tracker.carriers()).resolves.toEqual(first);
    expect(calls).toHaveLength(1);

    await clock.advance(2 * 60 * 60 * 1_000);
    await tracker.carriers();
    expect(calls).toHaveLength(2);
  });

  it('throws MissingKeyError when the tracker key is absent', async () => {
    const { tracker } = trackerWith(() => COMPANIES, { secrets: {} });

    await expect(tracker.carriers()).rejects.toBeInstanceOf(MissingKeyError);
    await expect(tracker.carriers()).rejects.toMatchObject({
      secretName: KO_SECRETS.sweetTracker,
      guide: expect.stringContaining('ax-kit secret set ko.sweettracker.key'),
    });
  });
});

describe('SweetTracker.track', () => {
  it('reports the last event and delivery state', async () => {
    const { tracker, calls } = trackerWith(() => TRACKING);

    const status = await tracker.track('11', '1234567890');

    expect(calls[0]?.url.searchParams.get('t_code')).toBe('11');
    expect(calls[0]?.url.searchParams.get('t_invoice')).toBe('1234567890');
    expect(status).toEqual({
      carrier: '11',
      invoice: '1234567890',
      state: '배송완료',
      lastEvent: { at: '2026-11-17 08:00', where: '예시동', what: '배송완료' },
      delivered: true,
    });
  });

  it('falls back to the transit word when there is no event yet', async () => {
    const { tracker } = trackerWith(() => ({ status: true, complete: false, trackingDetails: [] }));

    const status = await tracker.track('12', '42');

    expect(status).toMatchObject({ state: '배송중', delivered: false });
    expect(status.lastEvent).toBeUndefined();
  });

  it('throws a short error when the service rejects the invoice', async () => {
    const { tracker } = trackerWith(() => ({ status: false, msg: 'not found' }));
    await expect(tracker.track('12', '42')).rejects.toThrow(
      'Sweet Tracker rejected the tracking request.',
    );
  });

  it('rejects an unexpected response shape', async () => {
    const { tracker } = trackerWith(() => ({ nope: true }));
    await expect(tracker.track('12', '42')).rejects.toThrow(
      'Sweet Tracker returned an unexpected response.',
    );
  });
});
