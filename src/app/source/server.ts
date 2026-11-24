import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { z } from 'zod';
import type { Logger } from '../../core/log/types.js';
import { SOURCE_LIMITS, SOURCE_ROUTES, sourceRequests } from '../../core/remote/protocol.js';
import { SlidingWindow } from '../../mobile/limits.js';
import type { SourceOps } from './ops.js';
import { SourceRefusal } from './ops.js';
import type { PairedClient, SourceTokens } from './tokens.js';

export interface SourceServerOptions {
  ops: SourceOps;
  tokens: SourceTokens;
  /** This Mac's computer name, shown to the assistant's Mac when it pairs. */
  host: string;
  log: Logger;
  now?: () => Date;
  /** Requests per minute per paired Mac (default 240: a first look walks, then reads one file at a time). */
  perMinute?: number;
}

const MINUTE = 60_000;
const UNKNOWN_LIMIT = 20;
const PAIR_LIMIT = 10;
const MAX_TOKEN = 512;

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > SOURCE_LIMITS.requestBytes) throw new SourceRefusal('too large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  } catch {
    throw new SourceRefusal('bad json');
  }
}

function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec((header ?? '').trim());
  const token = match?.[1];
  return token !== undefined && token.length <= MAX_TOKEN ? token : undefined;
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SourceRefusal('bad request');
  return parsed.data as z.infer<T>;
}

/**
 * The work Mac's read-only API. Pairing is the only route without a token; every other route needs a paired Mac's
 * token and stays under its per-minute limit. Bad tokens and pairing tries have their own small limits.
 */
export function sourceHandler(options: SourceServerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const now = options.now ?? (() => new Date());
  const perToken = new SlidingWindow(MINUTE, options.perMinute ?? 240);
  const unknown = new SlidingWindow(10 * MINUTE, UNKNOWN_LIMIT);
  const pairing = new SlidingWindow(10 * MINUTE, PAIR_LIMIT);
  const { ops } = options;

  const routes: Record<string, (body: unknown, client: PairedClient) => Promise<unknown>> = {
    [SOURCE_ROUTES.info]: async () => await ops.info(options.host),
    [SOURCE_ROUTES.walk]: async (body) => {
      const input = parse(sourceRequests.walk, body);
      return await ops.walk(input.all, input.folders);
    },
    [SOURCE_ROUTES.excerpt]: async (body) => {
      const input = parse(sourceRequests.excerpt, body);
      return { text: await ops.excerpt(input.id, input.maxBytes) };
    },
    [SOURCE_ROUTES.repo]: async (body) => await ops.repo(parse(sourceRequests.repo, body).id),
    [SOURCE_ROUTES.repoDocs]: async (body) => {
      const input = parse(sourceRequests.repoDocs, body);
      return await ops.repoDocs(input.id, input.max);
    },
    [SOURCE_ROUTES.documentText]: async (body) => {
      const input = parse(sourceRequests.documentText, body);
      const text = await ops.documentText(input.id, input.maxChars);
      return text === undefined ? {} : { text };
    },
    [SOURCE_ROUTES.locate]: async (body) => {
      const root = await ops.locate(parse(sourceRequests.locate, body).path);
      return root === undefined ? {} : { root };
    },
    [SOURCE_ROUTES.sessions]: async () => await ops.sessionList(),
    [SOURCE_ROUTES.transcript]: async (body) => {
      const input = parse(sourceRequests.transcript, body);
      const text = await ops.transcript(input.tool, input.id, input.maxChars);
      return text === undefined ? {} : { text };
    },
    [SOURCE_ROUTES.find]: async (body) => {
      const input = parse(sourceRequests.find, body);
      return await ops.find(input.query, input.limit);
    },
  };

  const pair = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (pairing.over('pair', now())) {
      send(response, 429, { error: 'rate_limited' });
      return;
    }
    const input = parse(sourceRequests.pair, await readBody(request));
    const result = await options.tokens.redeem(input.code, input.name);
    if (result.status !== 'ok') {
      options.log.warn('source: a pairing try failed', { reason: result.status });
      send(response, result.status === 'full' ? 409 : 401, { error: result.status });
      return;
    }
    options.log.info('source: a Mac paired', { client: result.client.id });
    send(response, 200, { token: result.token, host: options.host });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const route = new URL(request.url ?? '/', 'http://source.invalid').pathname;
    if (request.method !== 'POST') {
      send(response, 405, { error: 'method' });
      return;
    }
    if (route === SOURCE_ROUTES.pair) {
      await pair(request, response);
      return;
    }
    const run = routes[route];
    const token = bearer(request.headers.authorization);
    const client = token === undefined ? undefined : await options.tokens.check(token);
    if (client === undefined) {
      send(response, unknown.over('unknown', now()) ? 429 : 401, { error: 'unauthorized' });
      return;
    }
    if (perToken.over(client.id, now())) {
      send(response, 429, { error: 'rate_limited' });
      return;
    }
    if (run === undefined) {
      send(response, 404, { error: 'not_found' });
      return;
    }
    send(response, 200, await run(await readBody(request), client));
  };

  return (request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return;
      if (error instanceof SourceRefusal) {
        send(response, 403, { error: 'refused', reason: error.message });
        return;
      }
      options.log.warn('source: a request failed', { error: error instanceof Error ? error.name : 'unknown' });
      send(response, 500, { error: 'failed' });
    });
  };
}

/** Listens on each address (the Tailscale one and 127.0.0.1); resolves once all are bound. */
export async function listenSource(handler: ReturnType<typeof sourceHandler>, hosts: readonly string[], port: number): Promise<Server[]> {
  const servers: Server[] = [];
  for (const host of hosts) {
    const server = createServer(handler);
    server.requestTimeout = 5 * MINUTE;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    servers.push(server);
  }
  return servers;
}
