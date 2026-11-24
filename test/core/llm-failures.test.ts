import { describe, expect, it } from 'vitest';
import { RoutingLlmGateway } from '../../src/core/llm/gateway.js';
import { LEDGER_MIGRATIONS, SqliteUsageLedger } from '../../src/core/llm/sqlite-ledger.js';
import type { LlmProvider, LlmRequest, UsageLedger } from '../../src/core/llm/types.js';
import { SqliteUsageReader, classifyLlmFailure } from '../../src/core/llm/usage-reader.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { openSqliteStore } from '../../src/core/store/sqlite.js';
import { FakeClock } from './helpers.js';

interface Failure {
  at: Date;
  purpose: string;
  providerId: string;
  model: string;
  code: string;
}

class RecordingLedger implements UsageLedger {
  readonly failures: Failure[] = [];
  async record(): Promise<void> {
    return undefined;
  }
  async spentUsd(): Promise<number> {
    return 0;
  }
  async recordFailure(entry: Failure): Promise<void> {
    this.failures.push(entry);
  }
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: 'test',
    tier: 'standard',
    sensitivity: 'public',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function failing(id: string, error: unknown): LlmProvider {
  return {
    id,
    async complete() {
      throw error;
    },
  };
}

function gateway(ledger: UsageLedger, provider: LlmProvider, clock: FakeClock): RoutingLlmGateway {
  return new RoutingLlmGateway({
    providers: [provider],
    routes: [{ providerId: provider.id, model: 'model-x', tiers: ['standard'], maxSensitivity: 'sensitive' }],
    budget: { dailyUsd: 1, monthlyUsd: 20 },
    ledger,
    timeZone: 'Asia/Seoul',
    log: silentLogger,
    clock,
  });
}

describe('classifyLlmFailure', () => {
  it('names the short failure classes', () => {
    expect(classifyLlmFailure(new Error('"claude" timed out after 120000ms'))).toBe('timeout');
    expect(classifyLlmFailure(new Error('The operation was aborted due to timeout'))).toBe('timeout');
    expect(classifyLlmFailure(new Error('"claude" was aborted'))).toBe('aborted');
    expect(classifyLlmFailure(new Error('login expired'))).toBe('login_expired');
    expect(classifyLlmFailure(new Error('401 Unauthorized'))).toBe('login_expired');
    expect(classifyLlmFailure(new Error('429 Too Many Requests'))).toBe('rate_limited');
    expect(classifyLlmFailure(new Error('quota exceeded'))).toBe('rate_limited');
    expect(classifyLlmFailure(new Error('socket hang up'))).toBe('error');
  });

  it('treats a TimeoutError name as a timeout even without a timeout word in the message', () => {
    const error = new Error('operation failed');
    error.name = 'TimeoutError';
    expect(classifyLlmFailure(error)).toBe('timeout');
  });
});

describe('gateway failure ledger', () => {
  it('records one classified failure per failed provider, without message text', async () => {
    const ledger = new RecordingLedger();
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    const router = gateway(ledger, failing('down', new Error('401 Unauthorized')), clock);

    await expect(router.complete(request())).rejects.toMatchObject({ code: 'provider_failed' });

    expect(ledger.failures).toEqual([
      {
        at: new Date('2026-03-08T12:00:00Z'),
        purpose: 'test',
        providerId: 'down',
        model: 'model-x',
        code: 'login_expired',
        tier: 'standard',
      },
    ]);
  });

  it('does not record a caller abort as a failure', async () => {
    const ledger = new RecordingLedger();
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    const controller = new AbortController();
    const provider: LlmProvider = {
      id: 'aborted',
      async complete() {
        controller.abort();
        throw new Error('aborted by caller');
      },
    };
    const router = gateway(ledger, provider, clock);

    await expect(router.complete(request({ signal: controller.signal }))).rejects.toThrow(
      'aborted by caller',
    );
    expect(ledger.failures).toEqual([]);
  });
});

describe('Sqlite usage reader', () => {
  it('sums calls, cost, tokens and failures per purpose', async () => {
    const store = openSqliteStore(':memory:');
    try {
      await store.migrate(LEDGER_MIGRATIONS);
      const ledger = new SqliteUsageLedger(store.sql);
      const reader = new SqliteUsageReader(store.sql);
      const at = (iso: string): Date => new Date(iso);

      await ledger.record({
        at: at('2026-03-02T01:00:00Z'),
        purpose: 'briefing.morning',
        providerId: 'p',
        model: 'm',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 },
      });
      await ledger.record({
        at: at('2026-03-02T02:00:00Z'),
        purpose: 'company.ops',
        providerId: 'p',
        model: 'm',
        usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 },
      });
      await ledger.record({
        at: at('2026-03-02T03:00:00Z'),
        purpose: 'company.ops',
        providerId: 'p',
        model: 'm',
        usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.01 },
      });
      await ledger.recordFailure({
        at: at('2026-03-02T04:00:00Z'),
        purpose: 'company.ops',
        providerId: 'p',
        model: 'm',
        code: 'error',
      });
      await ledger.recordFailure({
        at: at('2026-03-02T05:00:00Z'),
        purpose: 'company.team',
        providerId: 'p',
        model: 'm',
        code: 'timeout',
      });

      const all = await reader.byPurpose(at('2026-03-01T00:00:00Z'));
      expect(all.map((row) => row.purpose)).toEqual([
        'company.ops',
        'briefing.morning',
        'company.team',
      ]);
      expect(all[0]).toMatchObject({ calls: 2, failures: 1, inputTokens: 6, outputTokens: 3 });
      expect(all[0]?.costUsd).toBeCloseTo(0.02);
      expect(all[1]).toMatchObject({ calls: 1, failures: 0, inputTokens: 10, outputTokens: 5 });
      expect(all[2]).toMatchObject({ calls: 0, failures: 1 });

      const company = await reader.byPurpose(at('2026-03-01T00:00:00Z'), 'company.');
      expect(company.map((row) => row.purpose)).toEqual(['company.ops', 'company.team']);

      const models = await reader.byModel(at('2026-03-01T00:00:00Z'));
      const total = models.reduce((sum, row) => ({ calls: sum.calls + row.calls, failures: sum.failures + row.failures }), { calls: 0, failures: 0 });
      expect(total).toEqual({ calls: 3, failures: 2 });
      expect(models.every((row) => row.providerId !== '' && row.model !== '')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('excludes rows before the given instant', async () => {
    const store = openSqliteStore(':memory:');
    try {
      await store.migrate(LEDGER_MIGRATIONS);
      const ledger = new SqliteUsageLedger(store.sql);
      const reader = new SqliteUsageReader(store.sql);
      await ledger.record({
        at: new Date('2026-03-01T00:00:00Z'),
        purpose: 'old.feature',
        providerId: 'p',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
      });
      await ledger.recordFailure({
        at: new Date('2026-03-01T00:00:00Z'),
        purpose: 'old.failure',
        providerId: 'p',
        model: 'm',
        code: 'error',
      });

      expect(await reader.byPurpose(new Date('2026-03-02T00:00:00Z'))).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('escapes LIKE wildcards in the prefix', async () => {
    const store = openSqliteStore(':memory:');
    try {
      await store.migrate(LEDGER_MIGRATIONS);
      const ledger = new SqliteUsageLedger(store.sql);
      const reader = new SqliteUsageReader(store.sql);
      for (const purpose of ['a_b.x', 'axb.y', '100%.sales', '100x.sales']) {
        await ledger.record({
          at: new Date('2026-03-02T00:00:00Z'),
          purpose,
          providerId: 'p',
          model: 'm',
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        });
      }

      expect((await reader.byPurpose(new Date(0), 'a_b')).map((row) => row.purpose)).toEqual([
        'a_b.x',
      ]);
      expect((await reader.byPurpose(new Date(0), '100%')).map((row) => row.purpose)).toEqual([
        '100%.sales',
      ]);
    } finally {
      await store.close();
    }
  });

  it('prunes failures together with usage rows', async () => {
    const store = openSqliteStore(':memory:');
    try {
      await store.migrate(LEDGER_MIGRATIONS);
      const ledger = new SqliteUsageLedger(store.sql);
      await ledger.record({
        at: new Date('2026-01-01T00:00:00Z'),
        purpose: 'test',
        providerId: 'p',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
      });
      await ledger.recordFailure({
        at: new Date('2026-01-01T00:00:00Z'),
        purpose: 'test',
        providerId: 'p',
        model: 'm',
        code: 'error',
      });

      expect(ledger.prune(new Date('2026-02-01T00:00:00Z'))).toBe(2);
      expect(ledger.prune(new Date('2026-02-01T00:00:00Z'))).toBe(0);
    } finally {
      await store.close();
    }
  });
});
