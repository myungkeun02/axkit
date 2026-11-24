import { describe, expect, it } from 'vitest';
import { GoogleAuthError } from '../../../src/connectors/google/errors.js';
import { GoogleTokenSource } from '../../../src/connectors/google/token.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import { FakeClock } from '../../core/helpers.js';
import { fakeFetch, formBody, json } from './helpers.js';

const CLIENT = JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' });

function makeSource(fetchFn: typeof fetch, start = new Date('2026-11-17T09:00:00Z')) {
  const clock = new FakeClock(start);
  const secrets = new MemorySecretStore({
    'google.oauth-client': CLIENT,
    'google.refresh-token': 'refresh-1',
  });
  return { source: new GoogleTokenSource({ secrets, clock, fetch: fetchFn }), clock, secrets };
}

describe('GoogleTokenSource', () => {
  it('refreshes once, caches, and refreshes again after expiry', async () => {
    const fake = fakeFetch(() => json({ access_token: `access-${fake.calls.length}`, expires_in: 3600 }));
    const { source, clock } = makeSource(fake.fetch);

    expect(await source.accessToken()).toBe('access-1');
    expect(await source.accessToken()).toBe('access-1');
    expect(fake.calls).toHaveLength(1);

    const body = formBody(fake.calls[0]);
    expect(fake.calls[0]?.url.href).toBe('https://oauth2.googleapis.com/token');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret-1');

    await clock.advance(3_539_000);
    expect(await source.accessToken()).toBe('access-1');
    expect(fake.calls).toHaveLength(1);

    await clock.advance(1_000);
    expect(await source.accessToken()).toBe('access-2');
    expect(fake.calls).toHaveLength(2);
  });

  it('refreshes after invalidate', async () => {
    const fake = fakeFetch(() => json({ access_token: `access-${fake.calls.length}`, expires_in: 3600 }));
    const { source } = makeSource(fake.fetch);

    expect(await source.accessToken()).toBe('access-1');
    source.invalidate();
    expect(await source.accessToken()).toBe('access-2');
    expect(fake.calls).toHaveLength(2);
  });

  it('turns invalid_grant into advice about the Testing status', async () => {
    const fake = fakeFetch(() => json({ error: 'invalid_grant' }, 400));
    const { source } = makeSource(fake.fetch);

    const error = await source.accessToken().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as Error).message).toMatch(/ax-kit connect google/);
    expect((error as Error).message).toMatch(/Testing/);
    expect((error as Error).message).toMatch(/In production/);
  });

  it('fails with guidance when the secrets are missing', async () => {
    const fake = fakeFetch(() => json({ access_token: 'unused', expires_in: 3600 }));
    const source = new GoogleTokenSource({
      secrets: new MemorySecretStore(),
      clock: new FakeClock(),
      fetch: fake.fetch,
    });

    await expect(source.accessToken()).rejects.toThrow(/ax-kit connect google/);
    expect(fake.calls).toHaveLength(0);
  });
});
