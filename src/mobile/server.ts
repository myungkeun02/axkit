import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../core/log/types.js';
import type { Clock } from '../core/scheduler/types.js';
import type { MobileAdmin } from './admin.js';
import type { AuthGate } from './auth.js';
import type { IngestHandler } from './ingest.js';
import type { MobileTexts } from './locale.js';
import type { EmptyTextKind } from './schema.js';
import { parseIngestBody } from './schema.js';
import { readBody, sendHtml, sendJson, setSecurityHeaders } from './http.js';
import type { AppRouter } from './app-api.js';
import { APP_PREFIX } from './app-api.js';
import { apkRoute, appPairRoute, appRoute, contentDisposition } from './app-routes.js';
import type { ApkLinks } from './apk-links.js';
import type { InstallLinks } from './install-links.js';
import { installRoute } from './install-links.js';
import { reportRoute } from './install-source.js';
import { pairingDonePage, pairingFormPage, pairingMessagePage } from './pairing-html.js';

const MAX_INGEST_BYTES = 16 * 1024;
const MAX_CODE_BYTES = 1024;
const LISTEN_ATTEMPTS = 30;
const LISTEN_RETRY_MS = 1000;
const NONCE_PATH = /^\/m\/p\/([A-Za-z0-9_-]{1,128})$/;
const FILE_PATH = /^\/m\/p\/([A-Za-z0-9_-]{1,128})\/(\d{1,3})$/;
const APK_PATH = /^\/m\/apk\/([A-Za-z0-9_-]{1,128})$/;
const APP_PAIR_PATH = /^\/m\/p\/([A-Za-z0-9_-]{1,128})\/app$/;

export interface BridgeServerDeps {
  admin: MobileAdmin;
  app: AppRouter;
  apk?: ApkLinks;
  install?: InstallLinks;
  auth: AuthGate;
  ingest: IngestHandler;
  clock: Clock;
  log: Logger;
  texts: MobileTexts;
  timeZone: string;
}

export interface BridgeServerOptions {
  host: string;
  port: number;
  clock: Clock;
  log: Logger;
}

export interface BridgeServerHandle {
  port: number;
  close(): Promise<void>;
}

function emptyHint(texts: MobileTexts, kind: EmptyTextKind): string {
  switch (kind) {
    case 'sms':
      return texts.emptySms;
    case 'notification':
      return texts.emptyNotification;
    case 'voice_memo':
      return texts.emptyVoice;
  }
}

function safeContentType(value: string): string {
  return /^[\w.+-]+\/[\w.+-]+(?:;\s*charset=[\w-]+)?$/.test(value) ? value : 'application/octet-stream';
}

async function ingestRoute(deps: BridgeServerDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const auth = await deps.auth.authenticate(request.headers.authorization);
  if (auth.status === 'unauthorized') return sendJson(response, 401, { ok: false });
  if (auth.status === 'locked') return sendJson(response, 423, { ok: false });
  if (auth.status === 'rate_limited') return sendJson(response, 429, { ok: false });
  const body = await readBody(request, MAX_INGEST_BYTES);
  if (body === undefined) return sendJson(response, 413, { ok: false });

  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    await deps.auth.recordFailure(auth.device);
    return sendJson(response, 400, { ok: false, error: 'json' });
  }
  const parsed = parseIngestBody(raw, { now: deps.clock.now(), timeZone: deps.timeZone });
  if (!parsed.ok) {
    if (parsed.error === 'empty') {
      await deps.auth.recordSuccess(auth.device);
      return sendJson(response, 200, { ok: false, problem: emptyHint(deps.texts, parsed.kind) });
    }
    await deps.auth.recordFailure(auth.device);
    return sendJson(response, 400, { ok: false, error: parsed.error });
  }
  await deps.auth.recordSuccess(auth.device);
  const stored = await deps.ingest.handle(auth.device, parsed.at, parsed.items);
  return sendJson(response, 200, { ok: true, stored });
}

/** An app pairing opened in a browser must not spend its code there: the token belongs to the app. */
async function isAppPairing(deps: BridgeServerDeps, nonce: string): Promise<boolean> {
  const record = await deps.admin.getPairing(nonce);
  if (record === undefined) return false;
  return (await deps.admin.get(record.deviceId))?.client === 'app';
}

async function formRoute(deps: BridgeServerDeps, response: ServerResponse, nonce: string): Promise<void> {
  const record = await deps.admin.getPairing(nonce);
  if (record === undefined) {
    sendHtml(response, 410, pairingMessagePage(deps.texts, deps.texts.pairingExpired));
    return;
  }
  if (await isAppPairing(deps, nonce)) {
    sendHtml(response, 200, pairingMessagePage(deps.texts, deps.texts.pairingUseApp));
    return;
  }
  sendHtml(response, 200, pairingFormPage(deps.texts, nonce));
}

async function submitRoute(
  deps: BridgeServerDeps,
  request: IncomingMessage,
  response: ServerResponse,
  nonce: string,
): Promise<void> {
  const body = await readBody(request, MAX_CODE_BYTES);
  if (body === undefined) {
    sendJson(response, 413, { ok: false });
    return;
  }
  if (await isAppPairing(deps, nonce)) {
    sendHtml(response, 200, pairingMessagePage(deps.texts, deps.texts.pairingUseApp));
    return;
  }
  const code = (new URLSearchParams(body.toString('utf8')).get('code') ?? '').trim();
  const result = await deps.admin.unlock(nonce, code);
  if (result.status === 'ok') {
    sendHtml(
      response,
      200,
      pairingDonePage(deps.texts, nonce, result.files, result.unlockKey, result.connection),
    );
    return;
  }
  if (result.status === 'wrong') {
    sendHtml(response, 200, pairingFormPage(deps.texts, nonce, deps.texts.pairingWrong));
    return;
  }
  const message = result.status === 'burned' ? deps.texts.pairingBurned : deps.texts.pairingExpired;
  sendHtml(response, 410, pairingMessagePage(deps.texts, message));
}

async function fileRoute(
  deps: BridgeServerDeps,
  response: ServerResponse,
  nonce: string,
  index: number,
  key: string,
): Promise<void> {
  const file = await deps.admin.file(nonce, index, key);
  if (file === undefined) {
    sendJson(response, 404, { ok: false });
    return;
  }
  let data: Buffer;
  try {
    data = await readFile(file.path);
  } catch {
    deps.log.warn('mobile: pairing file is missing on disk', { index });
    sendJson(response, 404, { ok: false });
    return;
  }
  setSecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader('Content-Type', safeContentType(file.contentType));
  response.setHeader('Content-Disposition', contentDisposition(file.name));
  response.setHeader('Content-Length', String(data.length));
  response.end(data);
}

async function route(
  deps: BridgeServerDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://bridge.local');
  const path = url.pathname;
  if (path === '/m/health') {
    if (request.method !== 'GET') return sendJson(response, 405, { ok: false });
    return sendJson(response, 200, { ok: true });
  }
  if (path === '/m/v1/ingest') {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false });
    return ingestRoute(deps, request, response);
  }
  if (path.startsWith(APP_PREFIX)) return appRoute(deps, request, response, path.slice(APP_PREFIX.length));
  const apk = APK_PATH.exec(path);
  if (apk !== null) {
    if (request.method !== 'GET') return sendJson(response, 405, { ok: false });
    return apkRoute(deps, response, apk[1] ?? '');
  }
  if (path.startsWith('/m/install/')) {
    if (request.method === 'POST' && (await reportRoute(deps.install, path, request, response))) return;
    if (request.method !== 'GET') return sendJson(response, 405, { ok: false });
    if (await installRoute(deps.install, path, response)) return;
  }
  const appPair = APP_PAIR_PATH.exec(path);
  if (appPair !== null) {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false });
    return appPairRoute(deps, request, response, appPair[1] ?? '');
  }
  const file = FILE_PATH.exec(path);
  if (file !== null) {
    if (request.method !== 'GET') return sendJson(response, 405, { ok: false });
    return fileRoute(deps, response, file[1] ?? '', Number(file[2]), url.searchParams.get('k') ?? '');
  }
  const pairing = NONCE_PATH.exec(path);
  if (pairing !== null) {
    const nonce = pairing[1] ?? '';
    if (request.method === 'GET') return formRoute(deps, response, nonce);
    if (request.method === 'POST') return submitRoute(deps, request, response, nonce);
    return sendJson(response, 405, { ok: false });
  }
  return sendJson(response, 404, { ok: false });
}

/** The request handler, exported so tests can drive it without a socket. */
export function createBridgeHandler(deps: BridgeServerDeps): http.RequestListener {
  return (request, response) => {
    void route(deps, request, response).catch((error: unknown) => {
      deps.log.error('mobile: request failed', { error: error instanceof Error ? error.name : 'error' });
      if (!response.headersSent) sendJson(response, 500, { ok: false });
      else response.end();
    });
  };
}

function listenOnce(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function delay(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}

/** A restart overlaps the old daemon for a few seconds, so EADDRINUSE is retried before giving up. */
async function listenWithRetry(server: http.Server, options: BridgeServerOptions): Promise<boolean> {
  for (let attempt = 1; attempt <= LISTEN_ATTEMPTS; attempt += 1) {
    try {
      await listenOnce(server, options.host, options.port);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || options.port === 0 || attempt >= LISTEN_ATTEMPTS) {
        options.log.error('mobile: bridge server could not listen', { code: code ?? 'unknown', port: options.port });
        return false;
      }
      await delay(options.clock, LISTEN_RETRY_MS);
    }
  }
  return false;
}

export async function startBridgeServer(
  deps: BridgeServerDeps,
  options: BridgeServerOptions,
): Promise<BridgeServerHandle | undefined> {
  const server = http.createServer(createBridgeHandler(deps));
  const listening = await listenWithRetry(server, options);
  if (!listening) return undefined;
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
