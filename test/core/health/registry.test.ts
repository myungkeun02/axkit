import { describe, expect, it } from 'vitest';
import type { HealthCheck, HealthFinding } from '../../../src/core/contracts/health.js';
import { HealthChecks } from '../../../src/core/health/registry.js';

const NOW = new Date('2026-11-17T09:00:00.000Z');

function check(id: string, findings: HealthFinding[], seen?: Date[]): HealthCheck {
  return {
    id,
    async run(now: Date) {
      seen?.push(now);
      return findings;
    },
  };
}

describe('HealthChecks', () => {
  it('runs checks in registration order and keeps every finding', async () => {
    const seen: Date[] = [];
    const registry = new HealthChecks();
    registry.register(check('one', [{ id: 'one.a', area: 'ops', ok: true, line: 'a' }], seen));
    registry.register(
      check('two', [
        { id: 'two.a', area: 'notice', ok: true, line: 'a' },
        { id: 'two.b', area: 'notice', ok: false, line: 'b' },
      ]),
    );

    expect(await registry.runAll(NOW)).toEqual([
      { id: 'one.a', area: 'ops', ok: true, line: 'a' },
      { id: 'two.a', area: 'notice', ok: true, line: 'a' },
      { id: 'two.b', area: 'notice', ok: false, line: 'b' },
    ]);
    expect(seen).toEqual([NOW]);
  });

  it('rejects duplicate check ids', () => {
    const registry = new HealthChecks();
    registry.register(check('same', []));
    expect(() => registry.register(check('same', []))).toThrow('Duplicate health check: same');
  });

  it('turns a throwing check into one failed finding and keeps going', async () => {
    const registry = new HealthChecks();
    registry.register({
      id: 'broken',
      async run() {
        throw new Error('boom');
      },
    });
    registry.register(check('after', [{ id: 'after.ok', area: 'ops', ok: true, line: 'fine' }]));

    expect(await registry.runAll(NOW)).toEqual([
      { id: 'broken.error', area: 'ops', ok: false, line: 'broken: check failed' },
      { id: 'after.ok', area: 'ops', ok: true, line: 'fine' },
    ]);
  });
});
