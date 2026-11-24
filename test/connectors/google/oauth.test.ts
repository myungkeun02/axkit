import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTH_ENDPOINT,
  GOOGLE_SCOPES,
  buildAuthUrl,
  parseClientJson,
  pkcePair,
} from '../../../src/connectors/google/oauth.js';

describe('parseClientJson', () => {
  it('reads a Desktop app client file', () => {
    const text = JSON.stringify({
      installed: {
        client_id: 'client-1.apps.googleusercontent.com',
        client_secret: 'secret-1',
        redirect_uris: ['http://localhost'],
      },
    });
    expect(parseClientJson(text)).toEqual({
      clientId: 'client-1.apps.googleusercontent.com',
      clientSecret: 'secret-1',
    });
  });

  it('asks for a Desktop app client when given a web client', () => {
    const text = JSON.stringify({ web: { client_id: 'id', client_secret: 'secret' } });
    expect(() => parseClientJson(text)).toThrow(/Desktop app/);
  });

  it('rejects malformed input clearly', () => {
    expect(() => parseClientJson('not json')).toThrow(/not valid JSON/);
    expect(() => parseClientJson('[]')).toThrow(/OAuth client/);
    expect(() => parseClientJson('{"installed":{"client_id":"only-id"}}')).toThrow(/client_secret/);
  });
});

describe('pkcePair', () => {
  it('derives an S256 challenge from the verifier', () => {
    const { verifier, challenge } = pkcePair(() => new Uint8Array(32));
    expect(verifier).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });
});

describe('buildAuthUrl', () => {
  it('requests offline consent with PKCE', () => {
    const url = new URL(
      buildAuthUrl({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:49152',
        state: 'state-1',
        challenge: 'challenge-1',
        scopes: GOOGLE_SCOPES,
      }),
    );

    expect(url.origin + url.pathname).toBe(AUTH_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:49152');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_SCOPES.join(' '));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent select_account');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});
