import { describe, expect, it } from 'vitest';
import { KvJobRuns } from '../../src/core/scheduler/kv-runs.js';
import { TimerScheduler } from '../../src/core/scheduler/scheduler.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { FakeClock, MapKeyValueStore } from './helpers.js';

describe('scheduler run history', () => {
  it('keeps the last run of each job with duration, outcome and a masked, clipped error', async () => {
    const clock = new FakeClock(new Date('2026-11-18T00:00:00Z'));
    const kv = new MapKeyValueStore();
    const scheduler = new TimerScheduler({ timeZone: 'Asia/Seoul', log: silentLogger, clock, runs: new KvJobRuns(kv) });
    scheduler.add({ name: 'a.ok', label: 'Fine job', schedule: { kind: 'every', seconds: 60 }, run: async () => undefined });
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    scheduler.add({
      name: 'b.fail',
      schedule: { kind: 'every', seconds: 60 },
      run: async () => {
        throw new Error(`login failed for owner@example.com with ${secret} ${'x '.repeat(200)}`);
      },
    });

    expect((await scheduler.list()).map((job) => job.lastRun)).toEqual([undefined, undefined]);
    scheduler.start();
    await clock.advance(60_000);

    const [ok, fail] = await scheduler.list();
    expect(ok).toMatchObject({ name: 'a.ok', label: 'Fine job', running: false, lastRun: { ok: true, durationMs: 0 } });
    expect(ok?.nextRunAt?.toISOString()).toBe('2026-11-18T00:02:00.000Z');
    expect(fail?.lastRun?.ok).toBe(false);
    expect(fail?.lastRun?.error).toHaveLength(200);
    expect(fail?.lastRun?.error).not.toContain('owner@example.com');
    expect(fail?.lastRun?.error).not.toContain(secret);
    await scheduler.stop();

    // A new process reads the stored run before the job runs again.
    const again = new TimerScheduler({ timeZone: 'Asia/Seoul', log: silentLogger, clock, runs: new KvJobRuns(kv) });
    again.add({ name: 'b.fail', schedule: { kind: 'daily', at: '03:30' }, run: async () => undefined });
    const [stored] = await again.list();
    expect(stored?.lastRun?.ok).toBe(false);
    expect(stored?.nextRunAt).toBeUndefined();
  });

  it('marks a job running while it runs', async () => {
    const clock = new FakeClock(new Date('2026-11-18T00:00:00Z'));
    let release: () => void = () => undefined;
    const scheduler = new TimerScheduler({ timeZone: 'UTC', log: silentLogger, clock });
    scheduler.add({
      name: 'slow',
      schedule: { kind: 'every', seconds: 10 },
      run: () => new Promise<void>((resolve) => (release = resolve)),
    });
    scheduler.start();
    await clock.advance(10_000);
    expect((await scheduler.list())[0]).toMatchObject({ running: true, lastRun: { startedAt: '2026-11-18T00:00:10.000Z' } });
    release();
    await clock.advance(0);
    expect((await scheduler.list())[0]?.lastRun?.ok).toBe(true);
    await scheduler.stop();
  });
});
