import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../core/config/schema.js';
import type { HealthCheck, HealthFinding } from '../core/contracts/health.js';
import { KvDocStore } from '../core/docs/kv-doc-store.js';
import { docChecks, noticeChecks, switchChecks } from '../core/health/builtin.js';
import { uncommittedCodeCheck } from '../core/health/git-check.js';
import { KvNoticeStats } from '../core/notify/stats.js';
import { nodeProcessRunner } from '../core/process/node-runner.js';
import type { ProcessRunner } from '../core/process/types.js';
import { openSqliteStore } from '../core/store/sqlite.js';
import { SqliteSwitches, SWITCH_MIGRATIONS } from '../core/switches/sqlite-switches.js';
import { CODE_DIR } from './core-services.js';
import { coreTexts } from './core-texts.js';
import type { OptionalCheck } from './optional-checks.js';

export interface OpsCheckDeps {
  config: Config;
  home: string;
  now: Date;
  run?: ProcessRunner;
  codeDir?: string;
}

function toCheck(finding: HealthFinding): OptionalCheck {
  return {
    id: `ops.${finding.id}`,
    ok: finding.ok,
    detail: finding.line,
    ...(finding.fix !== undefined ? { fix: finding.fix } : {}),
  };
}

async function runChecks(checks: readonly HealthCheck[], now: Date): Promise<OptionalCheck[]> {
  const results: OptionalCheck[] = [];
  for (const check of checks) {
    try {
      results.push(...(await check.run(now)).map(toCheck));
    } catch {
      results.push({ id: `ops.${check.id}`, ok: false, detail: `${check.id}: check failed` });
    }
  }
  return results;
}

/**
 * The same standing checks the weekly report runs, read straight from the database for `ax-kit doctor`:
 * pauses left on, notice overload, documents to re-check, and uncommitted code in the running checkout.
 */
export async function opsChecks(deps: OpsCheckDeps): Promise<OptionalCheck[]> {
  const texts = coreTexts(deps.config.assistant.language).health;
  const run = deps.run ?? nodeProcessRunner;
  const code = uncommittedCodeCheck({ codeDir: deps.codeDir ?? CODE_DIR, run, texts });
  const path = join(deps.home, 'data', 'ax-kit.db');
  try {
    await access(path);
  } catch {
    return runChecks([code], deps.now);
  }
  const store = openSqliteStore(path);
  try {
    await store.migrate(SWITCH_MIGRATIONS);
    const now = (): Date => deps.now;
    const timeZone = deps.config.assistant.timezone;
    return await runChecks(
      [
        switchChecks(new SqliteSwitches(store.sql, now), { longDays: 7, texts }),
        noticeChecks(new KvNoticeStats(store.kv('core.notify'), timeZone), { texts, maxOverBudgetDays: 2 }),
        docChecks(new KvDocStore(store.kv('core.docs'), now), { texts, staleDays: 90 }),
        code,
      ],
      deps.now,
    );
  } finally {
    await store.close();
  }
}
