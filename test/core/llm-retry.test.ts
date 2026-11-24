import { describe, expect, it, vi } from 'vitest';
import { MemoryUsageLedger } from '../../src/core/llm/ledger.js';
import { ProviderCircuit } from '../../src/core/llm/circuit.js';
import { RoutingLlmGateway } from '../../src/core/llm/gateway.js';
import { LlmError } from '../../src/core/llm/types.js';
import type { LlmProvider, LlmRequest, LlmResponse, LlmRoute } from '../../src/core/llm/types.js';
import { LlmHttpError } from '../../src/core/llm/providers/http-error.js';
import { LlmTimeoutError } from '../../src/core/llm/providers/deadline.js';
import { DEFAULT_RETRY_POLICY, failureKind, retryDelay } from '../../src/core/llm/retry.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { FakeClock } from './helpers.js';

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { purpose: 'test', tier: 'standard', sensitivity: 'public', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

function ok(id: string, model: string): LlmResponse {
  return { text: 'ok', providerId: id, model, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } };
}

/** Fails with the listed errors in order, then answers. */
function scripted(id: string, errors: unknown[]): LlmProvider & { complete: ReturnType<typeof vi.fn> } {
  const queue = [...errors];
  return {
    id,
    complete: vi.fn(async (model: string) => {
      const next = queue.shift();
      if (next !== undefined) throw next;
      return ok(id, model);
    }),
  };
}

const route = (providerId: string): LlmRoute => ({ providerId, model: `${providerId}-m`, tiers: ['standard'], maxSensitivity: 'sensitive' });

function setup(providers: LlmProvider[], opts: { circuit?: ProviderCircuit; random?: () => number } = {}) {
  const ledger = new MemoryUsageLedger();
  const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
  const sleeps: number[] = [];
  const gateway = new RoutingLlmGateway({
    providers,
    routes: providers.map((provider) => route(provider.id)),
    budget: { dailyUsd: 1, monthlyUsd: 20 },
    ledger,
    timeZone: 'Asia/Seoul',
    log: silentLogger,
    clock,
    ...(opts.circuit !== undefined ? { circuit: opts.circuit } : {}),
    retry: {
      random: opts.random ?? (() => 0.5),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  });
  return { gateway, ledger, sleeps, clock };
}

describe('gateway retries', () => {
  it('retries a 503 on the same route with backoff and charges only the answer', async () => {
    const flaky = scripted('flaky', [new LlmHttpError(503, undefined), new LlmHttpError(529, undefined)]);
    const backup = scripted('backup', []);
    const { gateway, ledger, sleeps } = setup([flaky, backup]);

    const result = await gateway.complete(request());
    expect(result.providerId).toBe('flaky');
    expect(flaky.complete).toHaveBeenCalledTimes(3);
    expect(backup.complete).not.toHaveBeenCalled();
    // 500 * 2^(n-1) scaled by 0.5 + 0.5/2 = 0.75
    expect(sleeps).toEqual([375, 750]);
    expect(await ledger.spentUsd(new Date(0))).toBeCloseTo(0.01);
  });

  it('keeps jitter between half and the full backoff', () => {
    const error = new LlmHttpError(500, undefined);
    const low = retryDelay({ ...DEFAULT_RETRY_POLICY, random: () => 0 }, 2, error);
    const high = retryDelay({ ...DEFAULT_RETRY_POLICY, random: () => 0.999 }, 2, error);
    expect(low).toBe(500);
    expect(high).toBeLessThanOrEqual(1_000);
    expect(high).toBeGreaterThan(990);
  });

  it('moves on after the retries run out and reports a transient failure', async () => {
    const down = scripted('down', Array.from({ length: 10 }, () => new LlmHttpError(503, undefined)));
    const backup = scripted('backup', []);
    const { gateway, sleeps } = setup([down, backup]);

    const result = await gateway.complete(request());
    expect(result.providerId).toBe('backup');
    expect(down.complete).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it('honours Retry-After within the cap', async () => {
    const throttled = scripted('t', [new LlmHttpError(429, 4_000)]);
    const { gateway, sleeps } = setup([throttled]);
    await gateway.complete(request());
    expect(sleeps).toEqual([4_000]);
  });

  it('skips to the next route when Retry-After is beyond the cap', async () => {
    const throttled = scripted('t', [new LlmHttpError(429, 120_000)]);
    const backup = scripted('backup', []);
    const { gateway, sleeps } = setup([throttled, backup]);
    const result = await gateway.complete(request());
    expect(result.providerId).toBe('backup');
    expect(throttled.complete).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('does not retry a bad request or a rejected key', async () => {
    const bad = scripted('bad', [new LlmHttpError(400, undefined)]);
    const auth = scripted('auth', [new LlmHttpError(401, undefined)]);
    const good = scripted('good', []);
    const { gateway, sleeps } = setup([bad, auth, good]);
    const result = await gateway.complete(request());
    expect(result.providerId).toBe('good');
    expect(bad.complete).toHaveBeenCalledTimes(1);
    expect(auth.complete).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('retries a timeout only once', async () => {
    const slow = scripted('slow', [new LlmTimeoutError(90_000), new LlmTimeoutError(90_000), new LlmTimeoutError(90_000)]);
    const backup = scripted('backup', []);
    const { gateway } = setup([slow, backup]);
    expect((await gateway.complete(request())).providerId).toBe('backup');
    expect(slow.complete).toHaveBeenCalledTimes(2);
  });

  it('retries network errors', async () => {
    const network = new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });
    const flaky = scripted('flaky', [network]);
    const { gateway } = setup([flaky]);
    expect((await gateway.complete(request())).providerId).toBe('flaky');
    expect(flaky.complete).toHaveBeenCalledTimes(2);
  });

  it('counts one breaker failure per request, not per attempt', async () => {
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    const circuit = new ProviderCircuit({ clock });
    const down = scripted('down', Array.from({ length: 10 }, () => new LlmHttpError(503, undefined)));
    const { gateway } = setup([down], { circuit });
    await expect(gateway.complete(request())).rejects.toBeInstanceOf(LlmError);
    expect(circuit.snapshot()[0]).toMatchObject({ state: 'closed', failures: 1 });
  });

  it('stops at once when the caller aborts during the backoff', async () => {
    const controller = new AbortController();
    const flaky = scripted('flaky', [new LlmHttpError(503, undefined)]);
    const backup = scripted('backup', []);
    const ledger = new MemoryUsageLedger();
    const gateway = new RoutingLlmGateway({
      providers: [flaky, backup],
      routes: [route('flaky'), route('backup')],
      budget: { dailyUsd: 1, monthlyUsd: 20 },
      ledger,
      timeZone: 'Asia/Seoul',
      log: silentLogger,
      clock: new FakeClock(new Date('2026-03-08T12:00:00Z')),
      retry: { baseDelayMs: 60_000 },
    });
    const pending = gateway.complete(request({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(backup.complete).not.toHaveBeenCalled();
  });
});

describe('gateway failure details', () => {
  it('marks an all-transient failure as transient, with per-route detail', async () => {
    const a = scripted('a', Array.from({ length: 5 }, () => new LlmHttpError(503, undefined)));
    const b = scripted('b', [new LlmTimeoutError(10), new LlmTimeoutError(10)]);
    const { gateway } = setup([a, b]);
    const error = (await gateway.complete(request()).catch((caught: unknown) => caught)) as LlmError;
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe('provider_failed');
    expect(error.transient).toBe(true);
    expect(error.failures).toEqual([
      { providerId: 'a', model: 'a-m', kind: 'transient', code: 'error', attempts: 3, status: 503 },
      { providerId: 'b', model: 'b-m', kind: 'transient', code: 'timeout', attempts: 2 },
    ]);
    expect(error.message).toMatch(/^All providers failed: a: LLM request failed with status 503; b: /);
  });

  it('marks a bad request as not transient', async () => {
    const a = scripted('a', [new LlmHttpError(400, undefined)]);
    const { gateway } = setup([a]);
    const error = (await gateway.complete(request()).catch((caught: unknown) => caught)) as LlmError;
    expect(error.transient).toBe(false);
    expect(error.failures[0]).toMatchObject({ kind: 'request', status: 400, attempts: 1 });
  });

  it('marks paused providers as transient with the retry time', async () => {
    const clock = new FakeClock(new Date('2026-03-08T12:00:00Z'));
    const circuit = new ProviderCircuit({ clock, threshold: 1 });
    const a = scripted('a', Array.from({ length: 5 }, () => new LlmHttpError(500, undefined)));
    const { gateway } = setup([a], { circuit });
    await gateway.complete(request()).catch(() => undefined);
    const error = (await gateway.complete(request()).catch((caught: unknown) => caught)) as LlmError;
    expect(error.transient).toBe(true);
    expect(error.retryAt?.toISOString()).toBe('2026-03-08T12:05:00.000Z');
  });

  it('keeps no_route not transient', async () => {
    const { gateway } = setup([scripted('a', [])]);
    const error = (await gateway.complete(request({ tier: 'deep' })).catch((caught: unknown) => caught)) as LlmError;
    expect(error.code).toBe('no_route');
    expect(error.transient).toBe(false);
    expect(error.failures).toEqual([]);
  });

  it('classifies common provider errors', () => {
    expect(failureKind(new LlmHttpError(429, undefined))).toBe('transient');
    expect(failureKind(new LlmHttpError(403, undefined))).toBe('auth');
    expect(failureKind(new LlmHttpError(422, undefined))).toBe('request');
    expect(failureKind(new Error('LLM request failed with status 502'))).toBe('transient');
    expect(failureKind(new Error('Anthropic is overloaded'))).toBe('transient');
    expect(failureKind(new Error('"claude" timed out after 120000ms'))).toBe('transient');
    expect(failureKind(new Error('Claude Code CLI is not logged in. Run `claude` once'))).toBe('auth');
    expect(failureKind(new Error('Malformed response from LLM provider'))).toBe('request');
    expect(failureKind(new Error('boom'))).toBe('unknown');
  });
});
