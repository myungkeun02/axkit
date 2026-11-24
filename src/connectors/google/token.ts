import type { Clock } from '../../core/scheduler/types.js';
import type { SecretReader } from '../../core/secrets/types.js';
import { GoogleAuthError } from './errors.js';
import { parseJsonObject } from './json.js';
import type { GoogleClient } from './oauth.js';

export const OAUTH_CLIENT_SECRET = 'google.oauth-client';
export const REFRESH_TOKEN_SECRET = 'google.refresh-token';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const EXPIRY_MARGIN_SECONDS = 60;

const INVALID_GRANT_MESSAGE =
  'Google rejected the saved sign-in (invalid_grant). Run `ax-kit connect google` to connect again. ' +
  'If the OAuth consent screen is in "Testing" status, Google expires refresh tokens after 7 days; ' +
  'publish the OAuth app to "In production" to keep the connection.';

export interface GoogleTokenDeps {
  secrets: SecretReader;
  clock: Clock;
  fetch: typeof fetch;
  /** Which account's refresh token (another connected account keeps its own); default the first one. */
  refreshSecret?: string;
}

/** Exchanges the stored refresh token for cached access tokens. */
export class GoogleTokenSource {
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(private readonly deps: GoogleTokenDeps) {}

  async accessToken(signal?: AbortSignal): Promise<string> {
    const now = this.deps.clock.now().getTime();
    if (this.cached !== undefined && now < this.cached.expiresAt) return this.cached.token;

    const client = await this.readClient();
    const refreshToken = await this.deps.secrets.get(this.deps.refreshSecret ?? REFRESH_TOKEN_SECRET);
    if (refreshToken === undefined || refreshToken === '') {
      throw new GoogleAuthError('Google is not connected. Run `ax-kit connect google` to connect.');
    }

    const response = await this.deps.fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
    const payload = parseJsonObject(await response.text());

    if (!response.ok) {
      if (payload?.error === 'invalid_grant') throw new GoogleAuthError(INVALID_GRANT_MESSAGE);
      const detail = typeof payload?.error === 'string' ? `: ${payload.error}` : '';
      throw new GoogleAuthError(
        `Google token refresh failed (HTTP ${response.status})${detail}. Run \`ax-kit connect google\` to connect again.`,
      );
    }

    const accessToken = payload?.access_token;
    const expiresIn = payload?.expires_in;
    if (typeof accessToken !== 'string' || accessToken === '' || typeof expiresIn !== 'number') {
      throw new GoogleAuthError('Google returned an unexpected token response. Run `ax-kit connect google` to connect again.');
    }

    const lifetime = Math.max(0, expiresIn - EXPIRY_MARGIN_SECONDS);
    this.cached = { token: accessToken, expiresAt: now + lifetime * 1000 };
    return accessToken;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async readClient(): Promise<GoogleClient> {
    const raw = await this.deps.secrets.get(OAUTH_CLIENT_SECRET);
    if (raw === undefined) {
      throw new GoogleAuthError('Google is not connected. Run `ax-kit connect google` to connect.');
    }
    const parsed = parseJsonObject(raw);
    const clientId = parsed?.clientId;
    const clientSecret = parsed?.clientSecret;
    if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
      throw new GoogleAuthError('The saved Google client is unreadable. Run `ax-kit connect google` to connect again.');
    }
    return { clientId, clientSecret };
  }
}
