import type { ModelUsage, PurposeModelUsage, PurposeUsage, SplitBucket, UsageBucket, UsageReader } from '../contracts/usage.js';
import type { SqlDatabase, SqlParam } from '../store/types.js';

const TIMEOUT = /timed? ?out|timeout|etimedout/i;
const ABORT = /abort/i;
const LOGIN = /log ?in|login|unauthori[sz]ed|401|expired/i;
const RATE_LIMIT = /429|rate.?limit|quota|limit reached/i;

/** Short failure class for the ledger; provider messages may contain the owner's text, so they are not stored. */
export function classifyLlmFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  // A Node timeout is an AbortError whose message says "timeout"; check it first.
  if (name === 'TimeoutError' || TIMEOUT.test(message)) return 'timeout';
  if (name === 'AbortError' || ABORT.test(message)) return 'aborted';
  if (LOGIN.test(message)) return 'login_expired';
  if (RATE_LIMIT.test(message)) return 'rate_limited';
  return 'error';
}

interface UsageRow {
  purpose: string;
  calls: number;
  failures: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Reads the usage and failure ledgers together, so a feature group sees calls that never produced usage. */
export class SqliteUsageReader implements UsageReader {
  constructor(private readonly sql: SqlDatabase) {}

  async byPurpose(since: Date, prefix?: string): Promise<PurposeUsage[]> {
    const filter = prefix === undefined ? '' : " AND purpose LIKE ? ESCAPE '\\'";
    const sql = `
SELECT purpose,
       SUM(calls) AS calls,
       SUM(failures) AS failures,
       SUM(cost_usd) AS cost_usd,
       SUM(input_tokens) AS input_tokens,
       SUM(output_tokens) AS output_tokens
FROM (
  SELECT purpose, 1 AS calls, 0 AS failures, cost_usd, input_tokens, output_tokens
  FROM llm_usage WHERE at_ms >= ?${filter}
  UNION ALL
  SELECT purpose, 0 AS calls, 1 AS failures, 0 AS cost_usd, 0 AS input_tokens, 0 AS output_tokens
  FROM llm_failures WHERE at_ms >= ?${filter}
)
GROUP BY purpose
ORDER BY SUM(calls) + SUM(failures) DESC, purpose ASC`;

    const params: SqlParam[] = [since.getTime()];
    if (prefix !== undefined) params.push(likePrefix(prefix));
    params.push(since.getTime());
    if (prefix !== undefined) params.push(likePrefix(prefix));
    return this.sql.all(sql, ...params).map(toUsage);
  }

  async byModel(since: Date): Promise<ModelUsage[]> {
    const sql = `
SELECT provider_id, model,
       SUM(calls) AS calls, SUM(failures) AS failures, SUM(cost_usd) AS cost_usd,
       SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
FROM (
  SELECT provider_id, model, 1 AS calls, 0 AS failures, cost_usd, input_tokens, output_tokens FROM llm_usage WHERE at_ms >= ?
  UNION ALL
  SELECT provider_id, model, 0, 1, 0, 0, 0 FROM llm_failures WHERE at_ms >= ?
)
GROUP BY provider_id, model
ORDER BY SUM(cost_usd) DESC, SUM(calls) DESC, model ASC`;
    return this.sql.all(sql, since.getTime(), since.getTime()).map((row) => ({
      providerId: String(row.provider_id ?? ''),
      model: String(row.model ?? ''),
      calls: number(row.calls),
      failures: number(row.failures),
      costUsd: number(row.cost_usd),
      inputTokens: number(row.input_tokens),
      outputTokens: number(row.output_tokens),
    }));
  }

  async timelineSplit(since: Date, stepMs: number): Promise<SplitBucket[]> {
    const step = Math.max(60_000, Math.floor(stepMs));
    const sql = `
SELECT at_ms - (at_ms % ?) AS bucket, purpose, model, COUNT(*) AS calls, SUM(cost_usd) AS cost_usd
FROM llm_usage WHERE at_ms >= ?
GROUP BY bucket, purpose, model
ORDER BY bucket ASC`;
    return this.sql.all(sql, step, since.getTime()).map((row) => ({
      startMs: number(row.bucket),
      purpose: String(row.purpose ?? ''),
      model: String(row.model ?? ''),
      calls: number(row.calls),
      costUsd: number(row.cost_usd),
    }));
  }

  async timeline(since: Date, stepMs: number): Promise<UsageBucket[]> {
    const step = Math.max(60_000, Math.floor(stepMs));
    const sql = `
SELECT bucket, SUM(calls) AS calls, SUM(failures) AS failures, SUM(cost_usd) AS cost_usd
FROM (
  SELECT at_ms - (at_ms % ?) AS bucket, 1 AS calls, 0 AS failures, cost_usd FROM llm_usage WHERE at_ms >= ?
  UNION ALL
  SELECT at_ms - (at_ms % ?) AS bucket, 0, 1, 0 FROM llm_failures WHERE at_ms >= ?
)
GROUP BY bucket
ORDER BY bucket ASC`;
    const fromMs = since.getTime();
    return this.sql.all(sql, step, fromMs, step, fromMs).map((row) => ({
      startMs: number(row.bucket),
      calls: number(row.calls),
      failures: number(row.failures),
      costUsd: number(row.cost_usd),
    }));
  }

  async byPurposeModel(since: Date): Promise<PurposeModelUsage[]> {
    const sql = `
SELECT purpose, provider_id, model, tier,
       SUM(calls) AS calls, SUM(failures) AS failures, SUM(cost_usd) AS cost_usd
FROM (
  SELECT purpose, provider_id, model, tier, 1 AS calls, 0 AS failures, cost_usd FROM llm_usage WHERE at_ms >= ?
  UNION ALL
  SELECT purpose, provider_id, model, tier, 0, 1, 0 FROM llm_failures WHERE at_ms >= ?
)
GROUP BY purpose, provider_id, model, tier
ORDER BY purpose ASC, SUM(calls) DESC, model ASC`;
    return this.sql.all(sql, since.getTime(), since.getTime()).map((row) => ({
      purpose: String(row.purpose ?? ''),
      providerId: String(row.provider_id ?? ''),
      model: String(row.model ?? ''),
      tier: typeof row.tier === 'string' ? row.tier : null,
      calls: number(row.calls),
      failures: number(row.failures),
      costUsd: number(row.cost_usd),
    }));
  }
}

function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function toUsage(row: Record<string, unknown>): PurposeUsage {
  const mapped: UsageRow = {
    purpose: String(row.purpose ?? ''),
    calls: number(row.calls),
    failures: number(row.failures),
    costUsd: number(row.cost_usd),
    inputTokens: number(row.input_tokens),
    outputTokens: number(row.output_tokens),
  };
  return mapped;
}
