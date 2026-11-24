import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { createLogger } from '../../src/core/log/console-logger.js';

function makeBus(): { bus: InMemoryEventBus; lines: string[] } {
  const lines: string[] = [];
  const bus = new InMemoryEventBus(createLogger({ level: 'debug', sink: (line) => lines.push(line) }));
  return { bus, lines };
}

describe('InMemoryEventBus', () => {
  it('runs all handlers even when one throws, and logs the failure', async () => {
    const { bus, lines } = makeBus();
    const calls: string[] = [];

    bus.on('app.started', () => {
      calls.push('first');
      throw new Error('boom');
    });
    bus.on('app.started', async () => {
      calls.push('second');
    });

    await expect(bus.emit('app.started', { at: new Date() })).resolves.toBeUndefined();
    expect(calls).toEqual(['first', 'second']);
    expect(lines.some((line) => line.includes('event handler failed') && line.includes('app.started'))).toBe(true);
  });

  it('unsubscribes handlers', async () => {
    const { bus } = makeBus();
    let count = 0;
    const unsubscribe = bus.on('app.stopping', () => {
      count += 1;
    });

    await bus.emit('app.stopping', { reason: 'test' });
    unsubscribe();
    await bus.emit('app.stopping', { reason: 'test' });

    expect(count).toBe(1);
  });

  it('emit with no handlers resolves', async () => {
    const { bus } = makeBus();
    await expect(bus.emit('app.started', { at: new Date() })).resolves.toBeUndefined();
  });
});
