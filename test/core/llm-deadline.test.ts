import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../../src/core/llm/providers/anthropic.js';
import { createOpenAiCompatibleProvider } from '../../src/core/llm/providers/openai-compatible.js';
import { createCliProvider } from '../../src/core/llm/providers/cli.js';
import type { CliRunOptions, CliRunner } from '../../src/core/llm/providers/cli.js';
import { HTTP_DEADLINES_MS, deadlineFor, withDeadline } from '../../src/core/llm/providers/deadline.js';
import { LlmHttpError, parseRetryAfter } from '../../src/core/llm/providers/http-error.js';
import type { LlmRequest } from '../../src/core/llm/types.js';

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { purpose: 'test', tier: 'standard', sensitivity: 'public', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

/** A fetch that never answers until its signal aborts. */
function hangingFetch(seen: AbortSignal[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal !== undefined) seen.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
}

/** Headers arrive at once, the body never does, and the body read ignores the signal. */
function stalledBodyFetch(): typeof fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({ start: () => undefined });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('per-attempt deadlines', () => {
  it('picks a deadline per tier, with deep longer than the rest', () => {
    expect(deadlineFor('standard', undefined, HTTP_DEADLINES_MS)).toBe(90_000);
    expect(deadlineFor('deep', undefined, HTTP_DEADLINES_MS)).toBeGreaterThan(HTTP_DEADLINES_MS.standard);
    expect(deadlineFor('deep', 5_000, HTTP_DEADLINES_MS)).toBe(5_000);
    expect(deadlineFor('fast', { deep: 1 }, HTTP_DEADLINES_MS)).toBe(HTTP_DEADLINES_MS.fast);
    expect(deadlineFor('deep', { deep: 1 }, HTTP_DEADLINES_MS)).toBe(1);
  });

  it('times out an Anthropic request that never answers and aborts the fetch', async () => {
    const seen: AbortSignal[] = [];
    const provider = createAnthropicProvider({ id: 'a', apiKey: 'k', fetch: hangingFetch(seen), timeoutMs: 20 });
    const error = await provider.complete('m', request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'TimeoutError', message: 'LLM request timed out after 20ms' });
    expect(seen[0]?.aborted).toBe(true);
  });

  it('covers the body read too', async () => {
    const provider = createOpenAiCompatibleProvider({ id: 'o', baseUrl: 'https://x.test', fetch: stalledBodyFetch(), timeoutMs: 20 });
    await expect(provider.complete('m', request())).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('uses the tier deadline when configured per tier', async () => {
    const seen: AbortSignal[] = [];
    const provider = createOpenAiCompatibleProvider({
      id: 'o',
      baseUrl: 'https://x.test',
      fetch: hangingFetch(seen),
      timeoutMs: { fast: 15, deep: 60_000 },
    });
    await expect(provider.complete('m', request({ tier: 'fast' }))).rejects.toThrow(/after 15ms/);
  });

  it('combines the caller signal with the deadline', async () => {
    const seen: AbortSignal[] = [];
    const controller = new AbortController();
    const provider = createAnthropicProvider({ id: 'a', apiKey: 'k', fetch: hangingFetch(seen) });
    const pending = provider.complete('m', request({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen[0]?.aborted).toBe(true);
  });

  it('rejects at once for an already-aborted caller signal', async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    await expect(
      withDeadline(1_000, controller.signal, async () => {
        started = true;
        return 1;
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toBe(false);
  });

  it('throws an LlmHttpError carrying the status and Retry-After', async () => {
    const fetchImpl = (async () =>
      new Response('upstream detail', { status: 429, headers: { 'retry-after': '3' } })) as unknown as typeof fetch;
    const provider = createAnthropicProvider({ id: 'a', apiKey: 'k', fetch: fetchImpl });
    const error = await provider.complete('m', request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmHttpError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 3_000, message: 'LLM request failed with status 429' });
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('2')).toBe(2_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    const now = Date.parse('2026-03-08T12:00:00Z');
    expect(parseRetryAfter('Sun, 08 Mar 2026 12:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Sun, 08 Mar 2026 11:00:00 GMT', now)).toBe(0);
  });
});

describe('CLI provider deadlines', () => {
  function recordingRunner(calls: CliRunOptions[], settle = true): CliRunner {
    return async (_cmd, _args, _stdin, opts) => {
      calls.push(opts);
      if (!settle) return await new Promise(() => undefined);
      return { code: 0, stdout: JSON.stringify({ result: 'ok' }), stderr: '' };
    };
  }

  it('gives deep work a longer timeout than standard', async () => {
    const calls: CliRunOptions[] = [];
    const provider = createCliProvider({ id: 'c', kind: 'claude-cli', run: recordingRunner(calls) });
    await provider.complete('m', request({ tier: 'standard' }));
    await provider.complete('m', request({ tier: 'deep' }));
    expect(calls[0]?.timeoutMs).toBe(120_000);
    expect(calls[1]?.timeoutMs).toBe(300_000);
  });

  it('still returns when a runner never settles', async () => {
    const calls: CliRunOptions[] = [];
    const provider = createCliProvider({ id: 'c', kind: 'codex-cli', run: recordingRunner(calls, false), timeoutMs: 10 });
    await expect(provider.complete('m', request())).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(calls[0]?.signal?.aborted).toBe(true);
  });
});
