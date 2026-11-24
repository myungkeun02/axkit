import { describe, expect, it } from 'vitest';
import { LEDGER_MIGRATIONS } from '../../src/core/llm/sqlite-ledger.js';
import { AUDIT_MIGRATIONS } from '../../src/core/log/sqlite-audit.js';
import { SWITCH_MIGRATIONS } from '../../src/core/switches/sqlite-switches.js';

// The original assistant ended up with three pairs of clashing migration numbers (one used three times).
describe('migration ids', () => {
  const all = [...LEDGER_MIGRATIONS, ...AUDIT_MIGRATIONS, ...SWITCH_MIGRATIONS];

  it('are unique, including their number within a plugin', () => {
    const ids = all.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
    const numbers = ids.map((id) => id.replace(/-.*$/, ''));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('follow <plugin>/<NNN>-<name>', () => {
    for (const migration of all) expect(migration.id).toMatch(/^[a-z][a-z0-9.-]*\/\d{3}-[a-z0-9-]+$/);
  });
});
