import type { AuthorKind } from '../contracts/docs.js';
import type { FeatureSwitches, PauseInput, PauseState } from '../contracts/switches.js';
import type { Migration, SqlDatabase } from '../store/types.js';

const FEATURE = /^[a-z][a-z0-9._-]{0,79}$/;
const DAY_MS = 86_400_000;
const MAX_PAUSE_DAYS = 30;

export const SWITCH_MIGRATIONS: readonly Migration[] = [
  {
    id: 'core/003-switches',
    sql: `
CREATE TABLE IF NOT EXISTS feature_pauses (feature TEXT PRIMARY KEY, reason TEXT NOT NULL, until_ms INTEGER NOT NULL, by_kind TEXT NOT NULL, by_id TEXT NOT NULL, created_ms INTEGER NOT NULL, auto INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS feature_failures (feature TEXT NOT NULL, signature TEXT NOT NULL, at_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS feature_failures_at ON feature_failures (at_ms);
CREATE TABLE IF NOT EXISTS feature_runs (feature TEXT PRIMARY KEY, signature TEXT NOT NULL, count INTEGER NOT NULL, last_ms INTEGER NOT NULL);
`,
  },
];

function assertFeature(feature: string): void {
  if (!FEATURE.test(feature)) throw new Error('Invalid feature name');
}

function toState(row: Record<string, unknown>): PauseState {
  return {
    feature: String(row.feature),
    reason: String(row.reason),
    until: new Date(Number(row.until_ms)).toISOString(),
    byKind: String(row.by_kind) as AuthorKind,
    by: String(row.by_id),
    createdAt: new Date(Number(row.created_ms)).toISOString(),
    auto: Number(row.auto) === 1,
  };
}

/** Pauses always carry an end (at most 30 days out) and the breaker's pauses are marked automatic. */
export class SqliteSwitches implements FeatureSwitches {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly now: () => Date,
  ) {}

  async pause(feature: string, input: PauseInput): Promise<PauseState> {
    assertFeature(feature);
    const reason = input.reason.trim();
    if (reason === '') throw new Error('Pause reason is required');
    const nowMs = this.now().getTime();
    const untilMs = input.until.getTime();
    if (untilMs <= nowMs) throw new Error('Pause end must be in the future');
    if (untilMs > nowMs + MAX_PAUSE_DAYS * DAY_MS) throw new Error('Pause end must be within 30 days');
    return this.write(feature, reason, untilMs, input.by.kind, input.by.id, false);
  }

  /** The breaker owns its own short pause, so only caller-supplied dates need the 30-day ceiling. */
  async pauseAuto(feature: string, reason: string, until: Date): Promise<PauseState> {
    assertFeature(feature);
    const trimmed = reason.trim();
    if (trimmed === '') throw new Error('Pause reason is required');
    const untilMs = until.getTime();
    if (untilMs <= this.now().getTime()) throw new Error('Pause end must be in the future');
    return this.write(feature, trimmed, untilMs, 'policy', 'breaker', true);
  }

  async resume(feature: string): Promise<void> {
    assertFeature(feature);
    this.sql.run('DELETE FROM feature_pauses WHERE feature = ?', feature);
  }

  async pausedState(feature: string): Promise<PauseState | undefined> {
    assertFeature(feature);
    const row = this.sql.get('SELECT * FROM feature_pauses WHERE feature = ?', feature);
    if (row === undefined) return undefined;
    const state = toState(row);
    if (new Date(state.until).getTime() <= this.now().getTime()) {
      this.sql.run('DELETE FROM feature_pauses WHERE feature = ?', feature);
      return undefined;
    }
    return state;
  }

  async list(): Promise<PauseState[]> {
    this.sql.run('DELETE FROM feature_pauses WHERE until_ms <= ?', this.now().getTime());
    return this.sql.all('SELECT * FROM feature_pauses ORDER BY until_ms ASC').map(toState);
  }

  private write(
    feature: string,
    reason: string,
    untilMs: number,
    byKind: AuthorKind,
    byId: string,
    auto: boolean,
  ): PauseState {
    const createdAtMs = this.now().getTime();
    this.sql.run(
      `INSERT INTO feature_pauses (feature, reason, until_ms, by_kind, by_id, created_ms, auto)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (feature) DO UPDATE SET
         reason = excluded.reason,
         until_ms = excluded.until_ms,
         by_kind = excluded.by_kind,
         by_id = excluded.by_id,
         created_ms = excluded.created_ms,
         auto = excluded.auto`,
      feature,
      reason,
      untilMs,
      byKind,
      byId,
      createdAtMs,
      auto ? 1 : 0,
    );
    return {
      feature,
      reason,
      until: new Date(untilMs).toISOString(),
      byKind,
      by: byId,
      createdAt: new Date(createdAtMs).toISOString(),
      auto,
    };
  }
}
