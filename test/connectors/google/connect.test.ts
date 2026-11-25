import { describe, expect, it } from 'vitest';
import { connectGoogle } from '../../../src/connectors/google/connect.js';
import { GOOGLE_DRIVE_SCOPE, GOOGLE_SCOPES } from '../../../src/connectors/google/oauth.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import { fakeFetch, json } from './helpers.js';

const CLIENT_JSON = JSON.stringify({ installed: { client_id: 'client-id', client_secret: 'secret' } });

function redirect(authUrl: string): Promise<Response> {
  const auth = new URL(authUrl);
  const redirectUri = auth.searchParams.get('redirect_uri') ?? '';
  const state = auth.searchParams.get('state') ?? '';
  return globalThis.fetch(`${redirectUri}/?code=code-1&state=${encodeURIComponent(state)}`);
}

describe('connectGoogle', () => {
  it('stores the client and refresh token and reports unticked scopes', async () => {
    const tokenFetch = fakeFetch(() =>
      json({ refresh_token: 'refresh-1', scope: 'https://www.googleapis.com/auth/gmail.readonly' }),
    );
    const secrets = new MemorySecretStore();

    const result = await connectGoogle({
      secrets,
      clientJson: CLIENT_JSON,
      fetch: tokenFetch.fetch,
      openUrl: async (url) => {
        expect((await redirect(url)).status).toBe(200);
      },
    });

    expect(result.grantedScopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(result.missingScopes).toEqual([GOOGLE_SCOPES[0], GOOGLE_SCOPES[2], GOOGLE_SCOPES[3]]);
    expect(await secrets.get('google.oauth-client')).toBe(
      JSON.stringify({ clientId: 'client-id', clientSecret: 'secret' }),
    );
    expect(await secrets.get('google.refresh-token')).toBe('refresh-1');
  });

  it('requests extra scopes and reports them when not granted', async () => {
    const tokenFetch = fakeFetch(() =>
      json({ refresh_token: 'refresh-1', scope: [...GOOGLE_SCOPES].join(' ') }),
    );
    let requestedScopes: string[] = [];

    const result = await connectGoogle({
      secrets: new MemorySecretStore(),
      clientJson: CLIENT_JSON,
      fetch: tokenFetch.fetch,
      extraScopes: [GOOGLE_DRIVE_SCOPE],
      openUrl: async (url) => {
        requestedScopes = (new URL(url).searchParams.get('scope') ?? '').split(' ');
        await redirect(url);
      },
    });

    expect(requestedScopes).toContain(GOOGLE_DRIVE_SCOPE);
    expect(result.missingScopes).toEqual([GOOGLE_DRIVE_SCOPE]);
  });

  it('refuses a web client before opening a browser', async () => {
    const secrets = new MemorySecretStore();
    const clientJson = JSON.stringify({ web: { client_id: 'id', client_secret: 'secret' } });

    await expect(
      connectGoogle({
        secrets,
        clientJson,
        openUrl: async () => undefined,
        fetch: fakeFetch(() => json({})).fetch,
      }),
    ).rejects.toThrow(/Desktop app/);
    expect(await secrets.has('google.refresh-token')).toBe(false);
  });
});
