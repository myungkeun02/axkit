import { describe, expect, it } from 'vitest';
import { googleRequest } from '../../../src/connectors/google/http.js';
import type { GoogleRequestDeps } from '../../../src/connectors/google/http.js';
import { fakeFetch, json } from './helpers.js';

function deps(fetchFn: typeof fetch, overrides: Partial<GoogleRequestDeps> = {}): GoogleRequestDeps {
  return {
    fetch: fetchFn,
    tokens: { accessToken: async () => 'token-1', invalidate: () => undefined },
    sleep: async () => undefined,
    ...overrides,
  };
}

describe('googleRequest', () => {
  it('sends the bearer token and returns JSON', async () => {
    const fake = fakeFetch(() => json({ ok: true }));
    const result = await googleRequest<{ ok: boolean }>(deps(fake.fetch), 'https://example.com/data');

    expect(result).toEqual({ ok: true });
    expect(fake.calls[0]?.headers.get('authorization')).toBe('Bearer token-1');
  });

  it('invalidates the token and retries once on 401', async () => {
    let token = 'first';
    let invalidations = 0;
    const fake = fakeFetch(() => (fake.calls.length === 1 ? json({}, 401) : json({ ok: true })));
    const result = await googleRequest(
      deps(fake.fetch, {
        tokens: {
          accessToken: async () => token,
          invalidate: () => {
            invalidations += 1;
            token = 'second';
          },
        },
      }),
      'https://example.com/data',
    );

    expect(result).toEqual({ ok: true });
    expect(invalidations).toBe(1);
    expect(fake.calls.map((call) => call.headers.get('authorization'))).toEqual([
      'Bearer first',
      'Bearer second',
    ]);
  });

  it('sleeps and retries once on 429', async () => {
    const sleeps: number[] = [];
    const fake = fakeFetch(() => (fake.calls.length === 1 ? json({}, 429) : json({ ok: true })));
    const result = await googleRequest(
      deps(fake.fetch, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
      'https://example.com/data',
    );

    expect(result).toEqual({ ok: true });
    expect(sleeps).toEqual([1000]);
    expect(fake.calls).toHaveLength(2);
  });

  it('gives up after one retry on 5xx', async () => {
    const sleeps: number[] = [];
    const fake = fakeFetch(() => json({ error: { message: 'backend down' } }, 503));
    const request = googleRequest(
      deps(fake.fetch, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
      'https://example.com/data',
    );

    await expect(request).rejects.toThrow(/HTTP 503\).*backend down/);
    expect(sleeps).toEqual([1000]);
    expect(fake.calls).toHaveLength(2);
  });

  it('reports the status and Google message without leaking the token', async () => {
    const fake = fakeFetch(() => json({ error: { message: 'The request is missing a required parameter' } }, 400));
    const request = googleRequest(deps(fake.fetch), 'https://example.com/data');

    const error = await request.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('HTTP 400');
    expect((error as Error).message).toContain('The request is missing a required parameter');
    expect((error as Error).message).not.toContain('token-1');
  });
});
