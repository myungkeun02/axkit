import { describe, expect, it } from 'vitest';
import { RoutingLlmGateway } from '../../src/core/llm/gateway.js';
import { LEDGER_MIGRATIONS, SqliteUsageLedger } from '../../src/core/llm/sqlite-ledger.js';
import type { LlmProvider, LlmRequest } from '../../src/core/llm/types.js';
import { SqliteUsageReader } from '../../src/core/llm/usage-reader.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { openSqliteStore } from '../../src/core/store/sqlite.js';
import { FakeClock } from './helpers.js';

function request(purpose: string, tier: LlmRequest['tier']): LlmRequest {
  return { purpose, tier, sensitivity: 'public', messages: [{ role: 'user', content: 'hi' }] };
}

const ok = (id: string): LlmProvider => ({
  id,
  complete: async (model) => ({ text: 'ok', providerId: id, model, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } }),
});
const broken = (id: string): LlmProvider => ({
  id,
  complete: async () => {
    throw new Error('HTTP 503');
  },
});

describe('gateway tiers, breaker snapshot and usage timeline', () => {
  it('records the requested tier, describes routes and circuits, and buckets usage', async () => {
    const store = openSqliteStore(':memory:');
    await store.migrate(LEDGER_MIGRATIONS);
    const clock = new FakeClock(new Date('2026-11-18T00:10:00Z'));
    const ledger = new SqliteUsageLedger(store.sql);
    const gateway = new RoutingLlmGateway({
      providers: [broken('down'), ok('cheap')],
      routes: [
        { providerId: 'down', model: 'big', tiers: ['deep', 'standard'], maxSensitivity: 'sensitive' },
        { providerId: 'cheap', model: 'small', tiers: ['fast', 'standard'], maxSensitivity: 'public' },
        { providerId: 'absent', model: 'x', tiers: ['fast'], maxSensitivity: 'public' },
      ],
      budget: { dailyUsd: 10, monthlyUsd: 100 },
      ledger,
      timeZone: 'UTC',
      log: silentLogger,
      clock,
    });

    for (let i = 0; i < 3; i += 1) await gateway.complete(request('assistant.turn', 'standard'));
    await clock.advance(20 * 60_000);
    await gateway.complete(request('briefing.morning', 'fast'));

    const info = gateway.describe();
    expect(info.activeProviders).toEqual(['down', 'cheap']);
    expect(info.routes).toHaveLength(3);
    const down = info.circuits.find((circuit) => circuit.providerId === 'down');
    expect(down?.state).toBe('open');
    expect(down?.retryAt).toBeInstanceOf(Date);
    expect(info.circuits.find((circuit) => circuit.providerId === 'cheap')).toEqual({ providerId: 'cheap', state: 'closed', failures: 0 });

    const reader = new SqliteUsageReader(store.sql);
    const since = new Date('2026-11-18T00:00:00Z');
    const rows = await reader.byPurposeModel(since);
    expect(rows).toContainEqual(
      expect.objectContaining({ purpose: 'assistant.turn', providerId: 'cheap', model: 'small', tier: 'standard', calls: 3, failures: 0 }),
    );
    expect(rows).toContainEqual({ purpose: 'assistant.turn', providerId: 'down', model: 'big', tier: 'standard', calls: 0, failures: 3, costUsd: 0 });
    expect(rows).toContainEqual(expect.objectContaining({ purpose: 'briefing.morning', tier: 'fast', calls: 1 }));

    const buckets = await reader.timeline(since, 15 * 60_000);
    expect(buckets.map(({ startMs, calls, failures }) => ({ startMs, calls, failures }))).toEqual([
      { startMs: Date.parse('2026-11-18T00:00:00Z'), calls: 3, failures: 3 },
      { startMs: Date.parse('2026-11-18T00:30:00Z'), calls: 1, failures: 0 },
    ]);
    expect(buckets[0]?.costUsd).toBeCloseTo(0.03);
    await store.close();
  });
});
