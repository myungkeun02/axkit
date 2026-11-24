import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { googleRequest } from '../../../src/connectors/google/http.js';
import type { GoogleRequestDeps } from '../../../src/connectors/google/http.js';
import { runWithAbortSignal } from '../../../src/core/tools/abort-scope.js';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import { PolicyToolExecutor } from '../../../src/core/tools/executor.js';
import { DEFAULT_CONFIRM_POLICY } from '../../../src/core/policy/confirm.js';
import { MemoryAuditLog, silentLogger } from '../../../src/core/log/console-logger.js';

/** Never answers; records the signal each call got and whether it aborted. */
function hangingFetch(seen: AbortSignal[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal !== undefined) seen.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
}

function deps(fetchFn: typeof fetch, overrides: Partial<GoogleRequestDeps> = {}): GoogleRequestDeps {
  return {
    fetch: fetchFn,
    tokens: { accessToken: async () => 'token', invalidate: () => undefined },
    sleep: async () => undefined,
    ...overrides,
  };
}

describe('googleRequest cancellation', () => {
  it('uses the stop signal of the tool call it runs under', async () => {
    const seen: AbortSignal[] = [];
    const controller = new AbortController();
    const pending = runWithAbortSignal(controller.signal, () => googleRequest(deps(hangingFetch(seen)), 'https://example.com/x'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toHaveLength(1);
    controller.abort(new Error('tool stopped'));
    await expect(pending).rejects.toThrow('tool stopped');
    expect(seen[0]?.aborted).toBe(true);
  });

  it('still honours the request signal alongside the scoped one', async () => {
    const seen: AbortSignal[] = [];
    const scope = new AbortController();
    const own = new AbortController();
    const pending = runWithAbortSignal(scope.signal, () =>
      googleRequest(deps(hangingFetch(seen)), 'https://example.com/x', { signal: own.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    own.abort(new Error('own stop'));
    await expect(pending).rejects.toThrow('own stop');
    expect(seen[0]?.aborted).toBe(true);
  });

  it('stops waiting between retries when aborted', async () => {
    const controller = new AbortController();
    const fetchFn = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const pending = googleRequest(
      deps(fetchFn, { sleep: () => new Promise(() => undefined) }),
      'https://example.com/x',
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });

  it('cancels a hung Google call when the tool times out', async () => {
    const seen: AbortSignal[] = [];
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: 'google.read',
      description: 'Reads from Google',
      input: z.object({}),
      effects: ['read'],
      timeoutMs: 20,
      // The tool does not pass ctx.signal on; the executor's scope carries it.
      run: async () => await googleRequest(deps(hangingFetch(seen)), 'https://example.com/x'),
    });
    const executor = new PolicyToolExecutor({
      registry,
      confirmer: () => undefined,
      policy: DEFAULT_CONFIRM_POLICY,
      audit: new MemoryAuditLog(),
      log: silentLogger,
    });
    const outcome = await executor.execute('google.read', {});
    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/google\.read timed out/) });
    expect(seen[0]?.aborted).toBe(true);
  });
});
