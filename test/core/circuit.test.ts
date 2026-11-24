import { describe, expect, it } from 'vitest';
import { ProviderCircuit } from '../../src/core/llm/circuit.js';
import { createLogger } from '../../src/core/log/console-logger.js';
import { FakeClock } from './helpers.js';

const MINUTE = 60_000;

function setup(logLines?: string[]): { circuit: ProviderCircuit; clock: FakeClock } {
  const clock = new FakeClock(new Date('2026-03-08T00:00:00Z'));
  const log =
    logLines === undefined
      ? undefined
      : createLogger({ level: 'debug', sink: (line) => logLines.push(line) });
  return { clock, circuit: new ProviderCircuit({ clock, ...(log !== undefined ? { log } : {}) }) };
}

describe('ProviderCircuit', () => {
  it('opens after the threshold of consecutive failures and skips the provider', () => {
    const { circuit } = setup();
    circuit.recordFailure('p');
    circuit.recordFailure('p');
    expect(circuit.stateOf('p')).toBe('closed');
    expect(circuit.isAvailable('p')).toBe(true);

    circuit.recordFailure('p');
    expect(circuit.stateOf('p')).toBe('open');
    expect(circuit.isAvailable('p')).toBe(false);
    expect(circuit.acquire('p')).toBe(false);
    expect(circuit.retryAt('p')?.toISOString()).toBe('2026-03-08T00:05:00.000Z');
  });

  it('lets one trial through after the cooldown and closes on success', async () => {
    const { circuit, clock } = setup();
    for (let i = 0; i < 3; i += 1) circuit.recordFailure('p');

    await clock.advance(5 * MINUTE);
    expect(circuit.stateOf('p')).toBe('open');
    expect(circuit.isAvailable('p')).toBe(true);
    expect(circuit.acquire('p')).toBe(true);
    expect(circuit.acquire('p')).toBe(false);
    expect(circuit.isAvailable('p')).toBe(false);

    circuit.recordSuccess('p');
    expect(circuit.stateOf('p')).toBe('closed');
    expect(circuit.isAvailable('p')).toBe(true);
  });

  it('re-opens with a doubled cooldown when the trial fails', async () => {
    const { circuit, clock } = setup();
    for (let i = 0; i < 3; i += 1) circuit.recordFailure('p');

    await clock.advance(5 * MINUTE);
    circuit.acquire('p');
    circuit.recordFailure('p');

    expect(circuit.stateOf('p')).toBe('open');
    expect(circuit.retryAt('p')?.toISOString()).toBe('2026-03-08T00:15:00.000Z');

    await clock.advance(10 * MINUTE);
    circuit.acquire('p');
    circuit.recordFailure('p');
    expect(circuit.retryAt('p')?.toISOString()).toBe('2026-03-08T00:35:00.000Z');

    await clock.advance(20 * MINUTE);
    circuit.acquire('p');
    circuit.recordFailure('p');
    expect(circuit.retryAt('p')?.toISOString()).toBe('2026-03-08T01:05:00.000Z');

    await clock.advance(30 * MINUTE);
    circuit.acquire('p');
    circuit.recordFailure('p');
    expect(circuit.retryAt('p')?.toISOString()).toBe('2026-03-08T01:35:00.000Z');
  });

  it('resets the failure count on success', () => {
    const { circuit } = setup();
    circuit.recordFailure('p');
    circuit.recordFailure('p');
    circuit.recordSuccess('p');
    circuit.recordFailure('p');
    circuit.recordFailure('p');

    expect(circuit.stateOf('p')).toBe('closed');
    circuit.recordFailure('p');
    expect(circuit.stateOf('p')).toBe('open');
  });

  it('does not count aborts as failures and releases a half-open trial', async () => {
    const { circuit, clock } = setup();
    circuit.recordFailure('p');
    circuit.recordFailure('p');
    circuit.recordAbort('p');
    circuit.recordAbort('p');
    expect(circuit.stateOf('p')).toBe('closed');

    circuit.recordFailure('p');
    expect(circuit.stateOf('p')).toBe('open');

    await clock.advance(5 * MINUTE);
    expect(circuit.acquire('p')).toBe(true);
    circuit.recordAbort('p');
    expect(circuit.stateOf('p')).toBe('open');
    expect(circuit.retryAt('p')?.toISOString()).toBe('2026-03-08T00:05:00.000Z');
    expect(circuit.acquire('p')).toBe(true);
  });

  it('logs once when the circuit opens and once when it closes', async () => {
    const lines: string[] = [];
    const { circuit, clock } = setup(lines);
    for (let i = 0; i < 6; i += 1) circuit.recordFailure('p');
    expect(lines.filter((line) => line.includes('circuit opened'))).toHaveLength(1);

    await clock.advance(5 * MINUTE);
    circuit.acquire('p');
    circuit.recordSuccess('p');
    expect(lines.filter((line) => line.includes('circuit closed'))).toHaveLength(1);
  });

  it('reports the earliest retry among several providers', async () => {
    const { circuit, clock } = setup();
    for (let i = 0; i < 3; i += 1) circuit.recordFailure('slow');

    await clock.advance(MINUTE);
    for (let i = 0; i < 3; i += 1) circuit.recordFailure('late');

    expect(circuit.retryAfter(['slow', 'late'])?.toISOString()).toBe('2026-03-08T00:05:00.000Z');
    expect(circuit.retryAfter(['closed'])).toBeUndefined();
  });
});
