import type { Migration, SqlDatabase } from '../store/types.js';
import type { Tier, UsageLedger } from './types.js';

export const LEDGER_MIGRATIONS: readonly Migration[] = [
  {
    id: 'core/001-llm-usage',
    sql: `
CREATE TABLE IF NOT EXISTS llm_usage (
  at TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_usage_at_ms ON llm_usage (at_ms);
`,
  },
  {
    id: 'core/004-llm-failures',
    sql: `
CREATE TABLE IF NOT EXISTS llm_failures (
  at_ms INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  code TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_failures_at ON llm_failures (at_ms);
`,
  },
  {
    // The tier a request asked for, so the app can tell a purpose that ran on a model outside its tier.
    id: 'core/005-llm-tier',
    sql: `
ALTER TABLE llm_usage ADD COLUMN tier TEXT;
ALTER TABLE llm_failures ADD COLUMN tier TEXT;
`,
  },
];

/** SQLite-backed usage ledger, so the daily and monthly budget survives restarts. */
export class SqliteUsageLedger implements UsageLedger {
  constructor(private readonly sql: SqlDatabase) {}

  async record(entry: {
    at: Date;
    purpose: string;
    providerId: string;
    model: string;
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
    tier?: Tier;
  }): Promise<void> {
    this.sql.run(
      `INSERT INTO llm_usage
        (at, at_ms, purpose, provider_id, model, input_tokens, output_tokens, cost_usd, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.at.toISOString(),
      entry.at.getTime(),
      entry.purpose,
      entry.providerId,
      entry.model,
      entry.usage.inputTokens,
      entry.usage.outputTokens,
      entry.usage.costUsd,
      entry.tier ?? null,
    );
  }

  async spentUsd(since: Date): Promise<number> {
    const row = this.sql.get(
      'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_usage WHERE at_ms >= ?',
      since.getTime(),
    );
    return typeof row?.total === 'number' ? row.total : 0;
  }

  /** Keeps only the failure class: provider messages can hold prompts or the owner's data. */
  async recordFailure(entry: {
    at: Date;
    purpose: string;
    providerId: string;
    model: string;
    code: string;
    tier?: Tier;
  }): Promise<void> {
    this.sql.run(
      `INSERT INTO llm_failures (at_ms, purpose, provider_id, model, code, tier)
       VALUES (?, ?, ?, ?, ?, ?)`,
      entry.at.getTime(),
      entry.purpose,
      entry.providerId,
      entry.model,
      entry.code,
      entry.tier ?? null,
    );
  }

  /** Deletes entries older than `before`; returns how many rows were removed. */
  prune(before: Date): number {
    const usage = this.count('llm_usage', before);
    this.sql.run('DELETE FROM llm_usage WHERE at_ms < ?', before.getTime());
    const failures = this.count('llm_failures', before);
    this.sql.run('DELETE FROM llm_failures WHERE at_ms < ?', before.getTime());
    return usage + failures;
  }

  private count(table: 'llm_usage' | 'llm_failures', before: Date): number {
    const row = this.sql.get(`SELECT COUNT(*) AS count FROM ${table} WHERE at_ms < ?`, before.getTime());
    return typeof row?.count === 'number' ? row.count : 0;
  }
}
