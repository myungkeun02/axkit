import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEDGER_MIGRATIONS, SqliteUsageLedger } from '../../src/core/llm/sqlite-ledger.js';
import { RoutingLlmGateway } from '../../src/core/llm/gateway.js';
import type { LlmProvider, LlmRequest } from '../../src/core/llm/types.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { openSqliteStore } from '../../src/core/store/sqlite.js';
import type { Store } from '../../src/core/store/types.js';
import { FakeClock } from './helpers.js';

async function ledgerStore(): Promise<{ store: Store; ledger: SqliteUsageLedger }> {
  const store = openSqliteStore(':memory:');
  await store.migrate(LEDGER_MIGRATIONS);
  return { store, ledger: new SqliteUsageLedger(store.sql) };
}

function entry(at: string, costUsd: number) {
  return {
    at: new Date(at),
    purpose: 'test',
    providerId: 'p',
    model: 'm',
    usage: { inputTokens: 10, outputTokens: 5, costUsd },
  };
}

function request(): LlmRequest {
  return {
    purpose: 'test',
    tier: 'standard',
    sensitivity: 'sensitive',
    messages: [{ role: 'user', content: 'hello' }],
  };
}

describe('SqliteUsageLedger', () => {
  it('persists usage across reopening the same file and enforces the budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-kit-ledger-'));
    const path = join(dir, 'ax-kit.db');
    try {
      const first = openSqliteStore(path);
      expect(await first.migrate(LEDGER_MIGRATIONS)).toEqual([
        'core/001-llm-usage',
        'core/004-llm-failures',
        'core/005-llm-tier',
      ]);
      await new SqliteUsageLedger(first.sql).record(entry('2026-03-08T01:00:00Z', 0.4));
      await first.close();

      const second = openSqliteStore(path);
      try {
        expect(await second.migrate(LEDGER_MIGRATIONS)).toEqual([]);
        const ledger = new SqliteUsageLedger(second.sql);
        expect(await ledger.spentUsd(new Date('2026-03-08T00:00:00Z'))).toBeCloseTo(0.4);

        const calls: string[] = [];
        const p: LlmProvider = {
          id: 'p',
          async complete() {
            calls.push('p');
            return { text: 'ok', providerId: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
          },
        };
        const gateway = new RoutingLlmGateway({
          providers: [p],
          routes: [{ providerId: 'p', model: 'm', tiers: ['standard'], maxSensitivity: 'sensitive' }],
          budget: { dailyUsd: 0.25, monthlyUsd: 20 },
          ledger,
          timeZone: 'Asia/Seoul',
          log: silentLogger,
          clock: new FakeClock(new Date('2026-03-08T12:00:00Z')),
        });

        await expect(gateway.complete(request())).rejects.toMatchObject({ code: 'over_budget' });
        expect(calls).toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sums only entries at or after the given instant', async () => {
    const { store, ledger } = await ledgerStore();
    try {
      await ledger.record(entry('2026-01-01T00:00:00Z', 0.5));
      await ledger.record(entry('2026-01-02T00:00:00Z', 0.25));

      expect(await ledger.spentUsd(new Date('2026-01-02T00:00:00Z'))).toBeCloseTo(0.25);
      expect(await ledger.spentUsd(new Date(0))).toBeCloseTo(0.75);
    } finally {
      await store.close();
    }
  });

  it('prunes entries older than the cutoff', async () => {
    const { store, ledger } = await ledgerStore();
    try {
      await ledger.record(entry('2026-01-01T00:00:00Z', 0.5));
      await ledger.record(entry('2026-03-01T00:00:00Z', 0.25));

      expect(ledger.prune(new Date('2026-02-01T00:00:00Z'))).toBe(1);
      expect(await ledger.spentUsd(new Date(0))).toBeCloseTo(0.25);
      expect(ledger.prune(new Date('2027-01-01T00:00:00Z'))).toBe(1);
      expect(ledger.prune(new Date('2027-01-01T00:00:00Z'))).toBe(0);
    } finally {
      await store.close();
    }
  });
});
