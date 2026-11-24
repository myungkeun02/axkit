import { describe, expect, it } from 'vitest';
import { runLoopbackConsent } from '../../../src/connectors/google/loopback.js';
import { fakeFetch, formBody, json } from './helpers.js';

const CLIENT = { clientId: 'client-id', clientSecret: 'client-secret' };

function consent(fetchFn: typeof fetch, openUrl: (url: string) => Promise<void>, timeoutMs?: number) {
  return runLoopbackConsent({
    client: CLIENT,
    scopes: ['scope.a', 'scope.b'],
    openUrl,
    fetch: fetchFn,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

describe('runLoopbackConsent', () => {
  it('accepts a matching state and exchanges the code', async () => {
    const tokenFetch = fakeFetch(() =>
      json({
        access_token: 'access-1',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        scope: 'scope.a scope.b',
      }),
    );

    const result = await consent(tokenFetch.fetch, async (authUrl) => {
      const auth = new URL(authUrl);
      expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(auth.searchParams.get('access_type')).toBe('offline');
      expect(auth.searchParams.get('prompt')).toBe('consent select_account');
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');

      const redirectUri = auth.searchParams.get('redirect_uri') ?? '';
      const state = auth.searchParams.get('state') ?? '';
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const response = await globalThis.fetch(`${redirectUri}/?code=code-1&state=${encodeURIComponent(state)}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('완료됐어요');
    });

    expect(result).toEqual({ refreshToken: 'refresh-1', grantedScopes: ['scope.a', 'scope.b'] });
    const body = formBody(tokenFetch.calls[0]);
    expect(tokenFetch.calls[0]?.url.href).toBe('https://oauth2.googleapis.com/token');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_id')).toBe('client-id');
    expect(body.get('client_secret')).toBe('client-secret');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(body.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('rejects a wrong state with 400 and keeps waiting', async () => {
    const tokenFetch = fakeFetch(() => json({ refresh_token: 'refresh-1' }));

    const result = await consent(tokenFetch.fetch, async (authUrl) => {
      const auth = new URL(authUrl);
      const redirectUri = auth.searchParams.get('redirect_uri') ?? '';
      const state = auth.searchParams.get('state') ?? '';

      const wrong = await globalThis.fetch(`${redirectUri}/?code=code-1&state=wrong`);
      expect(wrong.status).toBe(400);

      const right = await globalThis.fetch(`${redirectUri}/?code=code-1&state=${encodeURIComponent(state)}`);
      expect(right.status).toBe(200);
    });

    expect(result.refreshToken).toBe('refresh-1');
  });

  it('rejects an error redirect', async () => {
    const tokenFetch = fakeFetch(() => json({ refresh_token: 'unused' }));

    const request = consent(tokenFetch.fetch, async (authUrl) => {
      const auth = new URL(authUrl);
      const redirectUri = auth.searchParams.get('redirect_uri') ?? '';
      const state = auth.searchParams.get('state') ?? '';
      const response = await globalThis.fetch(
        `${redirectUri}/?error=access_denied&state=${encodeURIComponent(state)}`,
      );
      expect(response.status).toBe(400);
    });

    await expect(request).rejects.toThrow(/access_denied/);
  });

  it('explains how to get a new refresh token when Google omits one', async () => {
    const tokenFetch = fakeFetch(() => json({ access_token: 'access-1', expires_in: 3600 }));

    const request = consent(tokenFetch.fetch, async (authUrl) => {
      const auth = new URL(authUrl);
      const redirectUri = auth.searchParams.get('redirect_uri') ?? '';
      const state = auth.searchParams.get('state') ?? '';
      await globalThis.fetch(`${redirectUri}/?code=code-1&state=${encodeURIComponent(state)}`);
    });

    await expect(request).rejects.toThrow(/myaccount\.google\.com\/permissions/);
  });

  it('times out and closes the server', async () => {
    const tokenFetch = fakeFetch(() => json({ refresh_token: 'unused' }));
    const request = consent(tokenFetch.fetch, async () => undefined, 20);

    await expect(request).rejects.toThrow(/timed out/);
    expect(tokenFetch.calls).toHaveLength(0);
  });
});
