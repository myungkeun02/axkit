import { describe, expect, it } from 'vitest';
import { SampleStore } from '../../src/mobile/samples.js';
import type { IngestItem } from '../../src/mobile/schema.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';
import { NOW } from './helpers.js';

function make() {
  const clock = new FakeClock(NOW);
  const kv = new MapKeyValueStore();
  const samples = new SampleStore(kv, clock, 'Asia/Seoul');
  return { clock, kv, samples };
}

function location(lat: number): IngestItem {
  return { kind: 'location', at: NOW, lat, lng: 127 };
}

describe('locations', () => {
  it('keeps the latest 50 and returns the newest within the age limit', async () => {
    const { samples, kv } = make();
    await samples.record(Array.from({ length: 55 }, (_, index) => location(index)), NOW);

    expect(((await kv.get<unknown[]>('locations')) ?? []).length).toBe(50);
    expect(await samples.latestLocation(60)).toMatchObject({ lat: 54, lng: 127 });
  });

  it('ignores locations older than the requested age', async () => {
    const { samples, clock } = make();
    await samples.record([location(37.5)], NOW);

    await clock.advance(90 * 60_000);
    expect(await samples.latestLocation(90)).toBeDefined();
    await clock.advance(60_000);
    expect(await samples.latestLocation(90)).toBeUndefined();
    expect(await samples.latestLocation(120)).toBeDefined();
  });

  it('keeps a label when one was sent', async () => {
    const { samples } = make();
    await samples.record([{ kind: 'location', at: NOW, lat: 37.5, lng: 127, label: 'example' }], NOW);

    expect(await samples.latestLocation(10)).toMatchObject({ label: 'example' });
  });
});

describe('daily totals', () => {
  it('takes the largest report of the day for steps and screen time', async () => {
    const { samples } = make();
    await samples.record(
      [
        { kind: 'steps', at: NOW, steps: 100 },
        { kind: 'steps', at: NOW, steps: 8000 },
        { kind: 'steps', at: NOW, steps: 5000 },
        { kind: 'screen_time', at: NOW, minutes: 120 },
        { kind: 'screen_time', at: NOW, minutes: 60 },
      ],
      NOW,
    );

    expect(await samples.dayTotals('2026-11-17')).toEqual({ steps: 8000, screenMinutes: 120 });
    expect(await samples.dayTotals('2026-11-16')).toEqual({});
  });

  it('uses the signaled date when the phone sent one', async () => {
    const { samples } = make();
    await samples.record([{ kind: 'steps', at: NOW, steps: 700, date: '2026-11-16' }], NOW);

    expect(await samples.dayTotals('2026-11-16')).toEqual({ steps: 700 });
    expect(await samples.dayTotals('2026-11-17')).toEqual({});
  });

  it('keeps only 60 days, dropping the oldest', async () => {
    const { samples, kv } = make();
    const base = Date.UTC(2026, 10, 17);
    for (let offset = 0; offset < 65; offset += 1) {
      const date = new Date(base - offset * 86_400_000).toISOString().slice(0, 10);
      await samples.record([{ kind: 'steps', at: NOW, steps: 100 + offset, date }], NOW);
    }

    const days = (await kv.get<Record<string, unknown>>('days')) ?? {};
    const keys = Object.keys(days);
    expect(keys).toHaveLength(60);
    expect(keys).toContain('2026-11-17');
    expect(keys).not.toContain('2026-09-14');
    expect(await samples.dayTotals('2026-09-14')).toEqual({});
  });
});

describe('last seen', () => {
  it('starts empty and updates on every successful ingest', async () => {
    const { samples, clock } = make();
    expect(await samples.lastSeen()).toBeUndefined();

    await samples.record([location(37.5)], NOW);
    expect(await samples.lastSeen()).toEqual(NOW);

    await clock.advance(5 * 60_000);
    await samples.record([location(37.6)], clock.now());
    expect(await samples.lastSeen()).toEqual(clock.now());
  });
});
