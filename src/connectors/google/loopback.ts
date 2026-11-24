import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { parseJsonObject } from './json.js';
import { buildAuthUrl, pkcePair } from './oauth.js';
import type { GoogleClient } from './oauth.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_TIMEOUT_MS = 300_000;

const DONE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>ax-kit</title></head><body>' +
  '<p>Done — you can close this tab. / 완료됐어요. 이 탭을 닫아도 돼요.</p></body></html>';
const WRONG_STATE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>ax-kit</title></head><body>' +
  '<p>This sign-in link is not valid. Please try again.</p><p>로그인 링크가 올바르지 않아요. 다시 시도해 주세요.</p></body></html>';
const ERROR_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>ax-kit</title></head><body>' +
  '<p>Sign-in did not finish. You can close this tab and try again.</p>' +
  '<p>로그인이 끝나지 않았어요. 이 탭을 닫고 다시 시도해 주세요.</p></body></html>';

export interface LoopbackConsentOptions {
  client: GoogleClient;
  scopes: readonly string[];
  openUrl: (url: string) => void | Promise<void>;
  fetch: typeof fetch;
  timeoutMs?: number;
}

export interface LoopbackConsentResult {
  refreshToken: string;
  grantedScopes: string[];
}

function respond(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
  res.end(html);
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not start the local sign-in server.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

interface WaitOptions {
  server: Server;
  state: string;
  redirectUri: string;
  authUrl: string;
  openUrl: LoopbackConsentOptions['openUrl'];
  timeoutMs: number;
}

function waitForCode(opts: WaitOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.server.off('request', onRequest);
      settle();
    };

    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'GET') {
        respond(res, 405, WRONG_STATE_HTML);
        return;
      }
      const url = new URL(req.url ?? '/', opts.redirectUri);
      if (url.pathname !== '/') {
        respond(res, 404, WRONG_STATE_HTML);
        return;
      }
      const error = url.searchParams.get('error');
      if (error !== null) {
        respond(res, 400, ERROR_HTML);
        finish(() => reject(new Error(`Google consent failed: ${error}`)));
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (code === null || state !== opts.state) {
        respond(res, 400, WRONG_STATE_HTML);
        return;
      }
      respond(res, 200, DONE_HTML);
      finish(() => resolve(code));
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('Google consent timed out. Run the connection again.')));
    }, opts.timeoutMs);

    opts.server.on('request', onRequest);
    Promise.resolve()
      .then(() => opts.openUrl(opts.authUrl))
      .catch((error: unknown) => {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      });
  });
}

async function exchangeCode(
  opts: LoopbackConsentOptions,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<LoopbackConsentResult> {
  const response = await opts.fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const payload = parseJsonObject(await response.text());

  if (!response.ok) {
    const error = typeof payload?.error === 'string' ? payload.error : undefined;
    const description = typeof payload?.error_description === 'string' ? payload.error_description : undefined;
    const detail = error === undefined ? '' : `: ${error}${description === undefined ? '' : ` (${description})`}`;
    throw new Error(`Google token exchange failed (HTTP ${response.status})${detail}`);
  }

  const refreshToken = payload?.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new Error(
      "Google did not return a refresh token. Remove this app's access at https://myaccount.google.com/permissions and retry.",
    );
  }

  const scope = payload?.scope;
  const grantedScopes =
    typeof scope === 'string' && scope.trim() !== ''
      ? scope.split(/\s+/).filter((value) => value !== '')
      : [...opts.scopes];

  return { refreshToken, grantedScopes };
}

/** Runs consent against a local loopback redirect and returns the refresh token. */
export async function runLoopbackConsent(opts: LoopbackConsentOptions): Promise<LoopbackConsentResult> {
  const server = createServer();
  try {
    const port = await listen(server);
    const redirectUri = `http://127.0.0.1:${port}`;
    const state = randomBytes(16).toString('base64url');
    const { verifier, challenge } = pkcePair();
    const authUrl = buildAuthUrl({
      clientId: opts.client.clientId,
      redirectUri,
      state,
      challenge,
      scopes: opts.scopes,
    });

    const code = await waitForCode({
      server,
      state,
      redirectUri,
      authUrl,
      openUrl: opts.openUrl,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    return await exchangeCode(opts, code, verifier, redirectUri);
  } finally {
    await closeServer(server);
  }
}
