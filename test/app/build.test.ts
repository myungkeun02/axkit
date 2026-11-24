import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/build.js';
import { parseConfig } from '../../src/core/config/load.js';
import { Contracts } from '../../src/core/contracts/index.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { SqliteAuditLog } from '../../src/core/log/sqlite-audit.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { openSqliteStore } from '../../src/core/store/sqlite.js';
import { FakeClock } from '../core/helpers.js';

const OWNER = '11111111111111111';

function config(quietHours?: { from: string; to: string }) {
  return parseConfig({
    version: 1,
    assistant: {
      name: '비서',
      language: 'ko',
      timezone: 'Asia/Seoul',
      ...(quietHours !== undefined ? { quietHours } : {}),
    },
    owner: { discordUserId: OWNER },
  });
}

describe('buildApp notifier', () => {
  it('provides the notifier and restores it after start', async () => {
    const app = await buildApp({
      config: config(),
      secrets: new MemorySecretStore(),
      log: silentLogger,
      plugins: [],
      storePath: ':memory:',
    });
    await app.start();
    try {
      const notifier = app.host.capability(Contracts.notifier);
      expect(notifier).toBeDefined();
      await expect(notifier?.notify({ text: 'hello', kind: 'test' })).resolves.toBe('held');
    } finally {
      await app.stop('test');
    }
  });

  it('persists audit entries and core migrations in the database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-kit-build-'));
    const storePath = join(dir, 'ax-kit.db');
    try {
      const app = await buildApp({
        config: config(),
        secrets: new MemorySecretStore(),
        log: silentLogger,
        plugins: [],
        storePath,
      });
      await app.start();
      try {
        await app.executor.execute('missing.tool', {});
      } finally {
        await app.stop('test');
      }

      const store = openSqliteStore(storePath);
      try {
        const ids = store.sql.all('SELECT id FROM _migrations ORDER BY id').map((row) => String(row.id));
        expect(ids).toEqual(['core/001-llm-usage', 'core/002-audit', 'core/003-switches', 'core/004-llm-failures', 'core/005-llm-tier', 'core/006-kill-switch', 'core/007-autonomy', 'core/008-work-log', 'core/009-owner-topics', 'core/010-autonomy-origin', 'core/011-autonomy-track']);
        expect(new SqliteAuditLog(store.sql).recent(1)[0]).toMatchObject({
          kind: 'tool',
          subject: 'missing.tool',
          detail: { status: 'failed', effects: [] },
        });
      } finally {
        await store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the configured quiet hours for non-urgent notices', async () => {
    const clock = new FakeClock(new Date('2026-11-17T01:00:00+09:00'));
    const app = await buildApp({
      config: config({ from: '00:00', to: '09:00' }),
      secrets: new MemorySecretStore(),
      log: silentLogger,
      plugins: [],
      storePath: ':memory:',
      clock,
    });
    await app.start();
    try {
      const notifier = app.host.capability(Contracts.notifier);
      await expect(notifier?.notify({ text: 'hello', kind: 'test' })).resolves.toBe('held');
    } finally {
      await app.stop('test');
    }
  });
});
