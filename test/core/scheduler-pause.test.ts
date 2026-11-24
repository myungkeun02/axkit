import { describe, expect, it } from 'vitest';
import { TimerScheduler } from '../../src/core/scheduler/scheduler.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { pauseCovering } from '../../src/core/switches/covering.js';
import type { PauseState } from '../../src/core/contracts/switches.js';
import { FakeClock } from './helpers.js';

const pause = (feature: string): PauseState => ({ feature, reason: 'r', until: '2026-12-01T00:00:00Z', byKind: 'user', by: 'owner', createdAt: '', auto: false });

describe('paused jobs (R6)', () => {
  it('covers the job, its prefix and its plugin, nothing else', () => {
    expect(pauseCovering('spending.mail', [pause('spending.mail')])?.feature).toBe('spending.mail');
    expect(pauseCovering('spending.mail', [pause('spending')])?.feature).toBe('spending');
    expect(pauseCovering('spending.mail', [pause('skill.spending')])?.feature).toBe('skill.spending');
    expect(pauseCovering('spending.mail', [pause('spend')])).toBeUndefined();
  });

  it('skips a paused job and runs it again once resumed; a broken check still runs it', async () => {
    const clock = new FakeClock(new Date('2026-11-19T00:00:00Z'));
    const scheduler = new TimerScheduler({ timeZone: 'Asia/Seoul', log: silentLogger, clock });
    let runs = 0;
    let paused = true;
    scheduler.add({ name: 'a.job', schedule: { kind: 'every', seconds: 60 }, run: async () => void (runs += 1) });
    scheduler.setPauseCheck(async () => paused);
    scheduler.start();
    await clock.advance(60_000);
    expect(runs).toBe(0);
    paused = false;
    await clock.advance(60_000);
    expect(runs).toBe(1);
    scheduler.setPauseCheck(async () => {
      throw new Error('store down');
    });
    await clock.advance(60_000);
    expect(runs).toBe(2);
    await scheduler.stop();
  });
});
