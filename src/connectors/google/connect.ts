import type { SecretStore } from '../../core/secrets/types.js';
import { runLoopbackConsent } from './loopback.js';
import { GOOGLE_SCOPES, parseClientJson } from './oauth.js';
import { OAUTH_CLIENT_SECRET, REFRESH_TOKEN_SECRET } from './token.js';

export interface ConnectGoogleOptions {
  secrets: SecretStore;
  clientJson: string;
  openUrl: (url: string) => void | Promise<void>;
  fetch?: typeof fetch;
  /** Opt-in scopes requested on top of the default mail and calendar ones (e.g. Drive read-only). */
  extraScopes?: readonly string[];
}

export interface ConnectGoogleResult {
  grantedScopes: string[];
  missingScopes: string[];
}

/** Runs the desktop OAuth flow and stores the client and refresh token. */
export async function connectGoogle(opts: ConnectGoogleOptions): Promise<ConnectGoogleResult> {
  const client = parseClientJson(opts.clientJson);
  const scopes = [...GOOGLE_SCOPES, ...(opts.extraScopes ?? [])];
  const { refreshToken, grantedScopes } = await runLoopbackConsent({
    client,
    scopes,
    openUrl: opts.openUrl,
    fetch: opts.fetch ?? fetch,
  });

  await opts.secrets.set(
    OAUTH_CLIENT_SECRET,
    JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret }),
  );
  await opts.secrets.set(REFRESH_TOKEN_SECRET, refreshToken);

  const missingScopes = scopes.filter((scope) => !grantedScopes.includes(scope));
  return { grantedScopes, missingScopes };
}
