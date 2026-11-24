import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Why a call to the other Mac failed, so setup can say what to do. */
export type RemoteFailure = 'unreachable' | 'unauthorized' | 'refused' | 'rate_limited' | 'bad_response' | 'timeout';

export class RemoteSourceError extends Error {
  override readonly name = 'RemoteSourceError';
  constructor(
    readonly reason: RemoteFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface PostOptions {
  token?: string;
  timeoutMs: number;
  /** Larger answers are cut off and refused. */
  maxBytes: number;
  signal?: AbortSignal;
}

/** Sends one POST to the other Mac; plain http over Tailscale (WireGuard already encrypts it) or https. */
export type PostJson = (base: string, route: string, body: unknown, opts: PostOptions) => Promise<unknown>;

function failureOf(status: number): RemoteFailure {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'refused';
}

/** "http://100.64.0.2:7787" style; only http(s) with a host, no credentials, no query. */
export function normalizeSourceUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim().includes('://') ? raw.trim() : `http://${raw.trim()}`);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined;
  return `${url.protocol}//${url.host}`;
}

export const nodePostJson: PostJson = (base, route, body, opts) =>
  new Promise((resolve, reject) => {
    const url = new URL(route, base);
    const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
      Accept: 'application/json',
    };
    if (opts.token !== undefined) headers['Authorization'] = `Bearer ${opts.token}`;
    const req = send(url, { method: 'POST', headers, timeout: opts.timeoutMs, ...(opts.signal !== undefined ? { signal: opts.signal } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > opts.maxBytes) {
          res.destroy();
          reject(new RemoteSourceError('bad_response', 'The answer from the other Mac was too large.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new RemoteSourceError(failureOf(status), `The other Mac answered ${status}.`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reject(new RemoteSourceError('bad_response', 'The other Mac sent something that is not JSON.'));
        }
      });
      res.on('error', () => reject(new RemoteSourceError('unreachable', 'The connection to the other Mac broke.')));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new RemoteSourceError('timeout', 'The other Mac did not answer in time.'));
    });
    req.on('error', (error) => {
      if (error instanceof RemoteSourceError) reject(error);
      else reject(new RemoteSourceError(opts.signal?.aborted === true ? 'timeout' : 'unreachable', 'The other Mac could not be reached.'));
    });
    req.end(payload);
  });
