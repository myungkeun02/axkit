import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';
import type { Clock } from '../../core/scheduler/types.js';

/**
 * APNs with a token-based (.p8) key: an ES256 JWT, reused for 50 minutes (Apple refuses one older than an hour and
 * also one refreshed more often than every 20 minutes), over one HTTP/2 session per host.
 * The key, key id and team id come from the keychain / config through `ApnsCredentials`; nothing here logs them or a
 * device token.
 */
export type ApnsEnvironment = 'development' | 'production';

export interface ApnsCredentials {
  /** The .p8 file's PEM text. */
  key: string;
  keyId: string;
  teamId: string;
}

export interface ApnsTarget {
  token: string;
  environment: ApnsEnvironment;
  topic: string;
}

export interface ApnsSendOptions {
  priority?: 5 | 10;
  collapseId?: string;
}

export interface ApnsResult {
  /** HTTP status from Apple; 0 = no answer (network, timeout, no key). */
  status: number;
  reason?: string;
}

export interface ApnsRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** The network step, injectable so tests answer without a request. */
export interface ApnsTransport {
  send(request: ApnsRequest): Promise<ApnsResult>;
  close?(): void;
}

export interface ApnsSender {
  send(target: ApnsTarget, payload: object, options?: ApnsSendOptions): Promise<ApnsResult>;
  close(): void;
}

export const APNS_HOSTS: Readonly<Record<ApnsEnvironment, string>> = {
  development: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com',
};

const TOKEN_TTL_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const EXPIRATION_MS = 24 * 60 * 60_000;
const KEY_ID = /^[A-Za-z0-9]{1,32}$/;

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** ES256 JWT `{alg, kid}.{iss, iat}` with a raw r||s signature (what APNs wants, not DER). */
export function signApnsJwt(credentials: ApnsCredentials, issuedAtSec: number): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
  const claims = b64url(JSON.stringify({ iss: credentials.teamId, iat: issuedAtSec }));
  const input = `${header}.${claims}`;
  const key = createPrivateKey(credentials.key);
  const signature = sign('sha256', Buffer.from(input, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

export function validCredentials(credentials: { [K in keyof ApnsCredentials]?: string | undefined }): credentials is ApnsCredentials {
  return (
    typeof credentials.key === 'string' &&
    credentials.key.includes('PRIVATE KEY') &&
    typeof credentials.keyId === 'string' &&
    KEY_ID.test(credentials.keyId) &&
    typeof credentials.teamId === 'string' &&
    KEY_ID.test(credentials.teamId)
  );
}

function reasonOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

/** One long-lived HTTP/2 session per APNs host, dropped on error / goaway and opened again on demand. */
export function http2Transport(): ApnsTransport {
  const sessions = new Map<string, http2.ClientHttp2Session>();
  const drop = (origin: string, session: http2.ClientHttp2Session): void => {
    if (sessions.get(origin) === session) sessions.delete(origin);
    if (!session.destroyed) session.destroy();
  };
  const sessionFor = (origin: string): http2.ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(origin);
    session.on('error', () => {
      drop(origin, session);
    });
    session.on('goaway', () => {
      drop(origin, session);
    });
    session.on('close', () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    });
    // An idle session must not keep the process alive at shutdown.
    session.unref();
    sessions.set(origin, session);
    return session;
  };

  return {
    send(request) {
      return new Promise<ApnsResult>((done) => {
        let finished = false;
        let status = 0;
        let raw = '';
        let stream: http2.ClientHttp2Stream | undefined;
        const finish = (result: ApnsResult): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          done(result);
        };
        const timer = setTimeout(() => {
          stream?.close(http2.constants.NGHTTP2_CANCEL);
          finish({ status: 0, reason: 'timeout' });
        }, REQUEST_TIMEOUT_MS);
        timer.unref();
        try {
          stream = sessionFor(`https://${request.host}`).request({
            ':method': 'POST',
            ':path': request.path,
            ...request.headers,
          });
        } catch {
          finish({ status: 0, reason: 'transport' });
          return;
        }
        stream.setEncoding('utf8');
        stream.on('response', (headers) => {
          status = Number(headers[':status']) || 0;
        });
        stream.on('data', (chunk: string) => {
          if (raw.length < 4096) raw += chunk;
        });
        stream.on('end', () => {
          const reason = reasonOf(raw);
          finish({ status, ...(reason !== undefined ? { reason } : {}) });
        });
        stream.on('error', () => {
          finish({ status: 0, reason: 'transport' });
        });
        stream.end(request.body);
      });
    },
    close() {
      for (const [origin, session] of sessions) drop(origin, session);
    },
  };
}

export interface ApnsSenderOptions {
  /** Read when a JWT is (re)made; undefined = push is not set up. */
  credentials: () => Promise<ApnsCredentials | undefined>;
  clock: Clock;
  transport?: ApnsTransport;
}

export function createApnsSender(options: ApnsSenderOptions): ApnsSender {
  const transport = options.transport ?? http2Transport();
  let cached: { jwt: string; keyId: string; madeAt: number } | undefined;

  const jwt = async (now: number): Promise<string | undefined> => {
    if (cached !== undefined && now - cached.madeAt < TOKEN_TTL_MS) return cached.jwt;
    const credentials = await options.credentials();
    if (credentials === undefined) return undefined;
    const made = signApnsJwt(credentials, Math.floor(now / 1000));
    cached = { jwt: made, keyId: credentials.keyId, madeAt: now };
    return made;
  };

  return {
    async send(target, payload, sendOptions = {}) {
      const now = options.clock.now().getTime();
      let token: string | undefined;
      try {
        token = await jwt(now);
      } catch {
        return { status: 0, reason: 'bad_key' };
      }
      if (token === undefined) return { status: 0, reason: 'no_key' };
      const headers: Record<string, string> = {
        authorization: `bearer ${token}`,
        'apns-topic': target.topic,
        'apns-push-type': 'alert',
        'apns-priority': String(sendOptions.priority ?? 10),
        'apns-expiration': String(Math.floor((now + EXPIRATION_MS) / 1000)),
        'content-type': 'application/json',
      };
      if (sendOptions.collapseId !== undefined) headers['apns-collapse-id'] = sendOptions.collapseId.slice(0, 64);
      try {
        const result = await transport.send({
          host: APNS_HOSTS[target.environment],
          path: `/3/device/${encodeURIComponent(target.token)}`,
          headers,
          body: JSON.stringify(payload),
        });
        // A key Apple rejects is made again on the next send instead of waiting out the cache.
        if (result.status === 403) cached = undefined;
        return result;
      } catch {
        return { status: 0, reason: 'transport' };
      }
    },
    close() {
      transport.close?.();
    },
  };
}
