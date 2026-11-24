import { describe, expect, it, vi } from 'vitest';
import { nextDailyRun, wallClock } from '../../src/core/scheduler/next-run.js';
import { TimerScheduler } from '../../src/core/scheduler/scheduler.js';
import { createLogger } from '../../src/core/log/console-logger.js';
import type { Job } from '../../src/core/scheduler/types.js';
import { FakeClock, flush } from './helpers.js';

describe('nextDailyRun', () => {
  it('finds the next run in Asia/Seoul', () => {
    const now = new Date('2026-03-08T00:00:00Z'); // 09:00 KST
    expect(nextDailyRun(now, '07:30', 'Asia/Seoul').toISOString()).toBe('2026-03-08T22:30:00.000Z');
  });

  it('is strictly after now', () => {
    const now = new Date('2026-03-07T22:30:00Z'); // 07:30 KST
    expect(nextDailyRun(now, '07:30', 'Asia/Seoul').toISOString()).toBe('2026-03-08T22:30:00.000Z');
  });

  it('handles ordinary days in America/New_York', () => {
    const now = new Date('2026-03-07T12:00:00Z'); // 07:00 EST
    expect(nextDailyRun(now, '09:00', 'America/New_York').toISOString()).toBe('2026-03-07T14:00:00.000Z');
  });

  it('uses the first instant after a DST gap', () => {
    const now = new Date('2026-03-08T00:00:00Z'); // Mar 7, 19:00 EST
    const next = nextDailyRun(now, '02:30', 'America/New_York');
    // 02:30 does not exist on 2026-03-08; clocks jump to 03:00 EDT at 07:00Z.
    expect(next.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('picks the earliest occurrence of an ambiguous time', () => {
    const now = new Date('2026-11-01T00:00:00Z'); // Oct 31, 20:00 EDT
    const next = nextDailyRun(now, '01:30', 'America/New_York');
    // 01:30 happens twice on 2026-11-01: 05:30Z (EDT) and 06:30Z (EST).
    expect(next.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rejects invalid times and zones', () => {
    expect(() => nextDailyRun(new Date(), '25:00', 'UTC')).toThrow(RangeError);
    expect(() => nextDailyRun(new Date(), '9:00', 'UTC')).toThrow(RangeError);
    expect(() => nextDailyRun(new Date(), '09:00', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('wallClock', () => {
  it('returns the wall clock in the requested zone', () => {
    const result = wallClock(new Date('2026-03-08T07:00:00Z'), 'America/New_York');
    expect(result).toEqual({ y: 2026, m: 3, d: 8, hh: 3, mm: 0, weekday: 'Sun' });
  });

  it('uses 00-23 hours', () => {
    const result = wallClock(new Date('2026-01-01T15:00:00Z'), 'Asia/Seoul');
    expect(result.hh).toBe(0);
  });
});

describe('TimerScheduler', () => {
  function setup(): { clock: FakeClock; lines: string[]; scheduler: TimerScheduler } {
    const clock = new FakeClock(new Date('2026-03-08T00:00:00Z'));
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const scheduler = new TimerScheduler({ timeZone: 'Asia/Seoul', log, clock });
    return { clock, lines, scheduler };
  }

  it('runs interval jobs after the interval and keeps a cadence', async () => {
    const { clock, scheduler } = setup();
    const runs: Date[] = [];
    scheduler.add({
      name: 'tick',
      schedule: { kind: 'every', seconds: 5 },
      run: async (now) => {
        runs.push(now);
      },
    });
    expect(scheduler.nextRun('tick')?.toISOString()).toBe('2026-03-08T00:00:05.000Z');

    scheduler.start();
    await clock.advance(5000);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.toISOString()).toBe('2026-03-08T00:00:05.000Z');
    expect(scheduler.nextRun('tick')?.toISOString()).toBe('2026-03-08T00:00:10.000Z');

    await clock.advance(5000);
    expect(runs).toHaveLength(2);
    await scheduler.stop();
  });

  it('removes a job for good: no more runs, gone from the list', async () => {
    const { clock, scheduler } = setup();
    let runs = 0;
    scheduler.add({ name: 'gone', schedule: { kind: 'every', seconds: 5 }, run: async () => { runs += 1; } });
    scheduler.start();
    await clock.advance(5000);
    expect(runs).toBe(1);
    expect(scheduler.remove('gone')).toBe(true);
    expect(scheduler.remove('gone')).toBe(false);
    await clock.advance(20_000);
    expect(runs).toBe(1);
    expect(scheduler.nextRun('gone')).toBeUndefined();
    expect((await scheduler.list()).map((job) => job.name)).not.toContain('gone');
    await scheduler.stop();
  });

  it('backs off quietly on network errors and reports once on recovery', async () => {
    const { clock, lines, scheduler } = setup();
    let offline = true;
    let calls = 0;
    scheduler.add({
      name: 'sync',
      schedule: { kind: 'every', seconds: 60 },
      run: async () => {
        calls += 1;
        if (offline) throw new Error('fetch failed: getaddrinfo ENOTFOUND api.example.com');
      },
    });
    scheduler.start();
    for (let minute = 0; minute < 10; minute += 1) await clock.advance(60_000);
    // 1st fail at 1m → wait 1m, 2nd at 2m → 2m, 3rd at 4m → 4m, 4th at 8m: four attempts in ten minutes, not ten
    expect(calls).toBe(4);
    expect(lines.filter((line) => line.includes('offline'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('scheduled job failed'))).toHaveLength(0);

    offline = false;
    for (let minute = 0; minute < 10; minute += 1) await clock.advance(60_000);
    expect(lines.filter((line) => line.includes('back online'))).toHaveLength(1);
    const after = calls;
    await clock.advance(60_000);
    expect(calls).toBe(after + 1);
    await scheduler.stop();
  });

  it('still logs ordinary job errors on every tick', async () => {
    const { clock, lines, scheduler } = setup();
    scheduler.add({ name: 'bad', schedule: { kind: 'every', seconds: 60 }, run: async () => { throw new Error('bug'); } });
    scheduler.start();
    for (let minute = 0; minute < 3; minute += 1) await clock.advance(60_000);
    expect(lines.filter((line) => line.includes('scheduled job failed'))).toHaveLength(3);
    await scheduler.stop();
  });

  it('skips a tick while the job is still running', async () => {
    const { clock, lines, scheduler } = setup();
    const runs: Date[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    scheduler.add({
      name: 'slow',
      schedule: { kind: 'every', seconds: 1 },
      run: async (now) => {
        runs.push(now);
        await gate;
      },
    });
    scheduler.start();
    await clock.advance(1000);
    expect(runs).toHaveLength(1);

    await clock.advance(1000);
    expect(runs).toHaveLength(1);
    expect(lines.some((line) => line.includes('skipping this tick'))).toBe(true);

    const stopping = scheduler.stop();
    release();
    await flush();
    await stopping;
  });

  it('logs errors but keeps scheduling', async () => {
    const { clock, lines, scheduler } = setup();
    let calls = 0;
    scheduler.add({
      name: 'flaky',
      schedule: { kind: 'every', seconds: 2 },
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('nope');
      },
    });
    scheduler.start();
    await clock.advance(2000);
    await clock.advance(2000);

    expect(calls).toBe(2);
    expect(lines.some((line) => line.includes('scheduled job failed') && line.includes('nope'))).toBe(true);
    await scheduler.stop();
  });

  it('stop awaits running jobs', async () => {
    const { clock, scheduler } = setup();
    let finished = false;
    scheduler.add({
      name: 'wait',
      schedule: { kind: 'every', seconds: 1 },
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
      },
    });
    scheduler.start();
    await clock.advance(1000);
    expect(finished).toBe(false);
    await scheduler.stop();
    expect(finished).toBe(true);
  });

  it('rejects duplicate and invalid schedules', () => {
    const { scheduler } = setup();
    const run = vi.fn(async () => undefined);
    scheduler.add({ name: 'dup', schedule: { kind: 'every', seconds: 1 }, run });

    expect(() => scheduler.add({ name: 'dup', schedule: { kind: 'every', seconds: 1 }, run })).toThrow(/Duplicate/);
    expect(() => scheduler.add({ name: 'zero', schedule: { kind: 'every', seconds: 0 }, run })).toThrow(RangeError);
    expect(() => scheduler.add({ name: 'nan', schedule: { kind: 'every', seconds: Number.NaN }, run })).toThrow(RangeError);
    expect(() => scheduler.add({ name: 'bad', schedule: { kind: 'daily', at: '24:00' }, run })).toThrow(RangeError);
  });

  it('schedules daily jobs in the configured time zone', async () => {
    const { clock, scheduler } = setup();
    const runs: Date[] = [];
    const job: Job = {
      name: 'briefing',
      schedule: { kind: 'daily', at: '07:30' },
      run: async (now) => {
        runs.push(now);
      },
    };
    scheduler.add(job);
    scheduler.start();
    expect(scheduler.nextRun('briefing')?.toISOString()).toBe('2026-03-08T22:30:00.000Z');

    await clock.advance(22.5 * 60 * 60 * 1000);
    expect(runs.map((run) => run.toISOString())).toEqual(['2026-03-08T22:30:00.000Z']);
    await scheduler.stop();
  });
});

describe('startOfLocalDay', () => {
  it('returns local midnight in Seoul', async () => {
    const { startOfLocalDay } = await import('../../src/core/scheduler/next-run.js');
    expect(startOfLocalDay(2026, 11, 17, 'Asia/Seoul').toISOString()).toBe('2026-11-16T15:00:00.000Z');
  });
});
