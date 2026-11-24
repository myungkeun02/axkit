import { describe, expect, it } from 'vitest';
import { TimerScheduler } from '../../src/core/scheduler/scheduler.js';
import { KvJobRuns } from '../../src/core/scheduler/kv-runs.js';
import { previousDailyDue, nextDueAfter } from '../../src/core/scheduler/catch-up.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { FakeClock, MapKeyValueStore, flush } from './helpers.js';

const BRIEFING_DUE = '2026-11-22T22:00:00.000Z'; // 07:00 KST on Nov 23

async function restartAt(iso: string, lastStartedAt: string | undefined): Promise<{ runs: string[]; stop: () => Promise<void> }> {
  const clock = new FakeClock(new Date(iso));
  const kv = new MapKeyValueStore();
  const store = new KvJobRuns(kv);
  if (lastStartedAt !== undefined) await store.write('briefing', { startedAt: lastStartedAt, ok: true });
  const scheduler = new TimerScheduler({ timeZone: 'Asia/Seoul', log: silentLogger, clock, runs: store });
  const runs: string[] = [];
  scheduler.add({ name: 'briefing', schedule: { kind: 'daily', at: '07:00' }, run: async (due) => void runs.push(due.toISOString()) });
  scheduler.start();
  await flush();
  await flush();
  return { runs, stop: () => scheduler.stop() };
}

describe('scheduler catch-up after the server was off', () => {
  it('runs a daily job missed a few minutes ago once at start', async () => {
    const { runs, stop } = await restartAt('2026-11-22T22:05:00Z', '2026-11-21T22:00:00Z');
    expect(runs).toEqual([BRIEFING_DUE]);
    await stop();
  });

  it('does not catch up outside the grace window, when it already ran, or without any stored run', async () => {
    for (const [now, last] of [
      ['2026-11-23T01:30:00Z', '2026-11-21T22:00:00Z'], // 3.5 h late
      ['2026-11-22T22:05:00Z', '2026-11-22T22:00:01Z'], // already ran today
      ['2026-11-22T22:05:00Z', undefined], // fresh install
    ] as const) {
      const { runs, stop } = await restartAt(now, last);
      expect(runs).toEqual([]);
      await stop();
    }
  });

  it('finds the latest daily due time at or before now', () => {
    expect(previousDailyDue(new Date('2026-11-22T22:05:00Z'), '07:00', 'Asia/Seoul').toISOString()).toBe(BRIEFING_DUE);
    expect(previousDailyDue(new Date(BRIEFING_DUE), '07:00', 'Asia/Seoul').toISOString()).toBe(BRIEFING_DUE);
    expect(previousDailyDue(new Date('2026-11-22T21:59:00Z'), '07:00', 'Asia/Seoul').toISOString()).toBe('2026-11-21T22:00:00.000Z');
  });
});

describe('scheduler after a Mac sleep', () => {
  it('coalesces missed interval ticks into one run and keeps the phase', async () => {
    const clock = new FakeClock(new Date('2026-11-23T00:00:00Z'));
    const scheduler = new TimerScheduler({ timeZone: 'UTC', log: silentLogger, clock });
    let runs = 0;
    scheduler.add({ name: 'sync', schedule: { kind: 'every', seconds: 60 }, run: async () => void (runs += 1) });
    scheduler.start();
    await clock.advance(60_000);
    expect(runs).toBe(1);
    clock.sleep(10 * 60_000 + 30_000);
    await clock.advance(60_000);
    expect(runs).toBe(2);
    expect(scheduler.nextRun('sync')?.toISOString()).toBe('2026-11-23T00:13:00.000Z');
    await scheduler.stop();
    expect(nextDueAfter({ kind: 'every', seconds: 60 }, 0, 600_500, 'UTC')).toBe(660_000);
  });

  it('fires a daily timer armed before the sleep within a minute of waking, not hours late', async () => {
    const clock = new FakeClock(new Date('2026-11-22T21:00:00Z')); // 06:00 KST
    const scheduler = new TimerScheduler({ timeZone: 'Asia/Seoul', log: silentLogger, clock });
    const runs: string[] = [];
    scheduler.add({ name: 'briefing', schedule: { kind: 'daily', at: '07:00' }, run: async (due) => void runs.push(due.toISOString()) });
    scheduler.start();
    clock.sleep(2 * 3_600_000); // wakes at 08:00 KST; the 07:00 timer would otherwise fire at 09:00
    await clock.advance(60_000);
    expect(runs).toEqual([BRIEFING_DUE]);
    expect(scheduler.nextRun('briefing')?.toISOString()).toBe('2026-11-23T22:00:00.000Z');
    await clock.advance(3_600_000);
    expect(runs).toHaveLength(1);
    await scheduler.stop();
  });
});
