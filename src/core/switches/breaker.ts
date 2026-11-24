import type { FailureCount, FailureReport, FeatureHealth } from '../contracts/switches.js';
import type { Notifier } from '../contracts/notify.js';
import type { Logger } from '../log/types.js';
import type { SqlDatabase } from '../store/types.js';
import type { SqliteSwitches } from './sqlite-switches.js';

const HOUR_MS = 3_600_000;
const DEFAULT_THRESHOLD = 5;
const DEFAULT_PAUSE_HOURS = 24;
const MAX_SIGNATURE = 60;

const SIGNATURE_CHARS = /[^a-z0-9_.:-]/g;

export interface BreakerTexts {
  paused(feature: string, signature: string, count: number, until: string): string;
}

export interface BreakerOptions {
  sql: SqlDatabase;
  switches: SqliteSwitches;
  now: () => Date;
  /** Resolved lazily: the channel plugin may start after the breaker. */
  notifier: () => Notifier | undefined;
  text: BreakerTexts;
  threshold?: number;
  pauseHours?: number;
  log: Logger;
}

function sanitizeSignature(signature: string): string {
  return signature.toLowerCase().replace(SIGNATURE_CHARS, '_').slice(0, MAX_SIGNATURE);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same failure N times in a row pauses the feature for a fixed short while and tells the owner once. */
export class FeatureBreaker implements FeatureHealth {
  private readonly threshold: number;
  private readonly pauseHours: number;

  constructor(private readonly opts: BreakerOptions) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.pauseHours = opts.pauseHours ?? DEFAULT_PAUSE_HOURS;
  }

  async recordFailure(report: FailureReport): Promise<'counted' | 'paused'> {
    const signature = sanitizeSignature(report.signature);
    const at = this.opts.now();
    this.opts.sql.run(
      'INSERT INTO feature_failures (feature, signature, at_ms) VALUES (?, ?, ?)',
      report.feature,
      signature,
      at.getTime(),
    );
    const previous = this.opts.sql.get(
      'SELECT signature, count FROM feature_runs WHERE feature = ?',
      report.feature,
    );
    const continued = previous !== undefined && String(previous.signature) === signature;
    const count = continued ? Number(previous.count) + 1 : 1;
    this.opts.sql.run(
      `INSERT INTO feature_runs (feature, signature, count, last_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (feature) DO UPDATE SET
         signature = excluded.signature, count = excluded.count, last_ms = excluded.last_ms`,
      report.feature,
      signature,
      count,
      at.getTime(),
    );
    if (count < this.threshold) return 'counted';
    if ((await this.opts.switches.pausedState(report.feature)) !== undefined) return 'counted';
    const until = new Date(at.getTime() + this.pauseHours * HOUR_MS);
    await this.opts.switches.pauseAuto(report.feature, `${signature} x${count}`, until);
    this.opts.sql.run('DELETE FROM feature_runs WHERE feature = ?', report.feature);
    await this.notifyOnce(report.feature, signature, count, until);
    return 'paused';
  }

  async recordSuccess(feature: string): Promise<void> {
    this.opts.sql.run('DELETE FROM feature_runs WHERE feature = ?', feature);
  }

  async failures(since: Date): Promise<FailureCount[]> {
    const rows = this.opts.sql.all(
      `SELECT feature, signature, COUNT(*) AS count FROM feature_failures
       WHERE at_ms >= ?
       GROUP BY feature, signature
       ORDER BY count DESC, feature ASC, signature ASC`,
      since.getTime(),
    );
    return rows.map((row) => ({
      feature: String(row.feature),
      signature: String(row.signature),
      count: Number(row.count),
    }));
  }

  /** Deletes failure rows older than `before`; returns how many were removed. */
  prune(before: Date): number {
    const row = this.opts.sql.get('SELECT COUNT(*) AS count FROM feature_failures WHERE at_ms < ?', before.getTime());
    const count = typeof row?.count === 'number' ? row.count : 0;
    this.opts.sql.run('DELETE FROM feature_failures WHERE at_ms < ?', before.getTime());
    return count;
  }

  private async notifyOnce(feature: string, signature: string, count: number, until: Date): Promise<void> {
    let notifier: Notifier | undefined;
    try {
      notifier = this.opts.notifier();
    } catch (error) {
      this.opts.log.error('breaker: notifier could not be resolved', { feature, error: errorMessage(error) });
      return;
    }
    if (notifier === undefined) return;
    try {
      await notifier.notify({
        kind: 'core.breaker',
        dedupeKey: feature,
        text: this.opts.text.paused(feature, signature, count, until.toISOString()),
      });
    } catch (error) {
      this.opts.log.error('breaker: pause notice failed', { feature, error: errorMessage(error) });
    }
  }
}
