import { describe, expect, it } from 'vitest';
import type { Notice, NoticeResult, Notifier } from '../../../src/core/contracts/notify.js';
import { createLogger, silentLogger } from '../../../src/core/log/console-logger.js';
import type { Logger } from '../../../src/core/log/types.js';
import { openSqliteStore } from '../../../src/core/store/sqlite.js';
import { FeatureBreaker, type BreakerTexts } from '../../../src/core/switches/breaker.js';
import { SWITCH_MIGRATIONS, SqliteSwitches } from '../../../src/core/switches/sqlite-switches.js';
import { FakeClock } from '../helpers.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const START = new Date('2026-11-17T09:00:00+09:00');

const TEXTS: BreakerTexts = {
  paused: (feature, signature, count, until) => `${feature}: ${signature} x${count} until ${until}`,
};

class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];
  constructor(private readonly fail = false) {}
  async notify(notice: Notice): Promise<NoticeResult> {
    if (this.fail) throw new Error('channel down');
    this.notices.push(notice);
    return 'sent';
  }
}

interface Options {
  threshold?: number;
  pauseHours?: number;
  notifier?: () => Notifier | undefined;
  log?: Logger;
}

async function make(opts: Options = {}) {
  const store = openSqliteStore(':memory:');
  await store.migrate(SWITCH_MIGRATIONS);
  const clock = new FakeClock(START);
  const switches = new SqliteSwitches(store.sql, () => clock.now());
  const breaker = new FeatureBreaker({
    sql: store.sql,
    switches,
    now: () => clock.now(),
    notifier: opts.notifier ?? (() => undefined),
    text: TEXTS,
    log: opts.log ?? silentLogger,
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    ...(opts.pauseHours !== undefined ? { pauseHours: opts.pauseHours } : {}),
  });
  return { store, clock, switches, breaker };
}

async function repeat(breaker: FeatureBreaker, feature: string, signature: string, times: number) {
  const results: string[] = [];
  for (let i = 0; i < times; i += 1) results.push(await breaker.recordFailure({ feature, signature }));
  return results;
}

describe('FeatureBreaker', () => {
  it('pauses on the fifth consecutive failure and notifies once', async () => {
    const notifier = new RecordingNotifier();
    const { breaker, switches, clock } = await make({ notifier: () => notifier });

    expect(await repeat(breaker, 'skill.mail', 'timeout', 4)).toEqual(['counted', 'counted', 'counted', 'counted']);
    expect(await breaker.recordFailure({ feature: 'skill.mail', signature: 'timeout' })).toBe('paused');

    const state = await switches.pausedState('skill.mail');
    expect(state).toMatchObject({ feature: 'skill.mail', reason: 'timeout x5', auto: true, by: 'breaker', byKind: 'policy' });
    expect(state?.until).toBe(new Date(clock.now().getTime() + 24 * HOUR_MS).toISOString());
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]).toMatchObject({ kind: 'core.breaker', dedupeKey: 'skill.mail' });
    expect(notifier.notices[0]?.text).toContain('timeout x5');

    expect(await breaker.recordFailure({ feature: 'skill.mail', signature: 'timeout' })).toBe('counted');
    expect(notifier.notices).toHaveLength(1);
    expect((await switches.pausedState('skill.mail'))?.until).toBe(state?.until);
  });

  it('starts a new run when the signature changes', async () => {
    const notifier = new RecordingNotifier();
    const { breaker, switches } = await make({ threshold: 3, notifier: () => notifier });

    await repeat(breaker, 'skill.mail', 'timeout', 2);
    expect(await breaker.recordFailure({ feature: 'skill.mail', signature: 'http_503' })).toBe('counted');
    expect(await breaker.recordFailure({ feature: 'skill.mail', signature: 'http_503' })).toBe('counted');
    expect(await switches.pausedState('skill.mail')).toBeUndefined();
    expect(await breaker.recordFailure({ feature: 'skill.mail', signature: 'http_503' })).toBe('paused');
    expect((await switches.pausedState('skill.mail'))?.reason).toBe('http_503 x3');
  });

  it('resets the run after a success', async () => {
    const notifier = new RecordingNotifier();
    const { breaker, switches } = await make({ threshold: 3, notifier: () => notifier });

    await repeat(breaker, 'skill.mail', 'timeout', 2);
    await breaker.recordSuccess('skill.mail');
    await repeat(breaker, 'skill.mail', 'timeout', 2);
    expect(await switches.pausedState('skill.mail')).toBeUndefined();
    expect(notifier.notices).toEqual([]);

    expect(await breaker.recordFailure({ feature: 'skill.mail', signature: 'timeout' })).toBe('paused');
    expect((await switches.pausedState('skill.mail'))?.reason).toBe('timeout x3');
  });

  it('sanitizes signatures to a stable lowercase class of at most 60 characters', async () => {
    const { breaker } = await make({ threshold: 100 });
    await breaker.recordFailure({ feature: 'skill.mail', signature: 'HTTP 503!' });
    await breaker.recordFailure({ feature: 'skill.mail', signature: 'A'.repeat(70) });

    const failures = await breaker.failures(new Date(0));
    expect(failures.map((failure) => failure.signature).sort()).toEqual(['a'.repeat(60), 'http_503_']);
  });

  it('groups failures by feature and signature, largest first', async () => {
    const { breaker } = await make({ threshold: 100 });
    await repeat(breaker, 'skill.a', 'sig_x', 3);
    await repeat(breaker, 'skill.a', 'sig_y', 2);
    await repeat(breaker, 'skill.b', 'sig_z', 4);

    expect(await breaker.failures(new Date(0))).toEqual([
      { feature: 'skill.b', signature: 'sig_z', count: 4 },
      { feature: 'skill.a', signature: 'sig_x', count: 3 },
      { feature: 'skill.a', signature: 'sig_y', count: 2 },
    ]);
  });

  it('prunes failure rows older than the cutoff and reports how many', async () => {
    const { breaker, clock } = await make({ threshold: 100 });
    await repeat(breaker, 'skill.a', 'sig', 3);
    await clock.advance(2 * DAY_MS);

    expect(breaker.prune(new Date(clock.now().getTime() - DAY_MS))).toBe(3);
    expect(await breaker.failures(new Date(0))).toEqual([]);
    expect(breaker.prune(new Date(clock.now().getTime() - DAY_MS))).toBe(0);
  });

  it('logs a failing notifier and still pauses', async () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const notifier = new RecordingNotifier(true);
    const { breaker, switches } = await make({ notifier: () => notifier, log });

    await repeat(breaker, 'skill.mail', 'timeout', 5);
    expect((await switches.pausedState('skill.mail'))?.auto).toBe(true);
    expect(lines.some((line) => line.includes('breaker: pause notice failed'))).toBe(true);
  });

  it('logs a notifier resolver failure and still pauses', async () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const { breaker, switches } = await make({
      notifier: () => {
        throw new Error('not ready');
      },
      log,
    });

    await repeat(breaker, 'skill.mail', 'timeout', 5);
    expect((await switches.pausedState('skill.mail'))?.auto).toBe(true);
    expect(lines.some((line) => line.includes('breaker: notifier could not be resolved'))).toBe(true);
  });
});
