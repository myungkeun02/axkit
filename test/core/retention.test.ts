import { describe, expect, it } from 'vitest';
import { openSqliteStore } from '../../src/core/store/sqlite.js';
import { SqliteAuditLog, AUDIT_MIGRATIONS } from '../../src/core/log/sqlite-audit.js';
import { SqliteUsageLedger, LEDGER_MIGRATIONS } from '../../src/core/llm/sqlite-ledger.js';
import { retentionJob } from '../../src/core/log/retention.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { FakeClock } from './helpers.js';

const DAY = 86_400_000;
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0.01 };

describe('retention job', () => {
  it('prunes usage and audit rows older than the configured days only', async () => {
    const store = openSqliteStore(':memory:');
    await store.migrate([...LEDGER_MIGRATIONS, ...AUDIT_MIGRATIONS]);
    const ledger = new SqliteUsageLedger(store.sql);
    const audit = new SqliteAuditLog(store.sql);
    const now = new Date('2026-11-17T00:00:00Z');
    const clock = new FakeClock(now);
    const at = (days: number) => new Date(now.getTime() - days * DAY);

    await ledger.record({ at: at(500), purpose: 'p', providerId: 'x', model: 'm', usage });
    await ledger.record({ at: at(10), purpose: 'p', providerId: 'x', model: 'm', usage });
    await audit.append({ at: at(400), kind: 'tool', subject: 'old' });
    await audit.append({ at: at(5), kind: 'tool', subject: 'new' });

    const job = retentionJob({ usage: ledger, audit, usageDays: 400, auditDays: 365, clock, log: silentLogger });
    expect(job.schedule).toEqual({ kind: 'daily', at: '04:10' });
    await job.run(now);

    expect(await ledger.spentUsd(at(1000))).toBeCloseTo(0.01);
    expect(audit.recent(10).map((entry) => entry.subject)).toEqual(['new']);
    await store.close();
  });
});
