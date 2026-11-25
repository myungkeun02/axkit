import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  DeviceApi,
  DeviceApiHandler,
  DeviceApiResponse,
  DeviceCaller,
  DeviceApiRequest,
  DeviceEventStream,
  DeviceFile,
  DeviceUpload,
} from '../core/contracts/device-api.js';
import type { Logger } from '../core/log/types.js';
import { readBody, readJson, sendJson, setSecurityHeaders } from './http.js';

export const APP_PREFIX = '/m/v1/app/';
const MAX_JSON_BYTES = 64 * 1024;
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const KEEPALIVE_MS = 25_000;
const MAX_STREAMS_PER_DEVICE = 3;

interface RouteEntry {
  method: 'GET' | 'POST';
  segments: readonly string[];
  handler: DeviceApiHandler;
}

type StreamOpen = (caller: DeviceCaller, stream: DeviceEventStream, lastEventId?: string) => void;
type DownloadHandler = (request: DeviceApiRequest) => Promise<DeviceFile | undefined>;

/** Path parameters: card ids, view names, file ids (docs/APP-PROTOCOL.md §7.3, §7.5). Never `.`/`..` alone. */
const PARAM = /^[A-Za-z0-9_.:-]{1,200}$/;

const UPLOAD_HEADERS = ['x-chunk-total', 'x-started-at', 'x-duration-sec', 'x-channel'] as const;

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function match(segments: readonly string[], parts: readonly string[]): Record<string, string> | undefined {
  if (segments.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    const part = parts[index] ?? '';
    if (segment.startsWith(':')) {
      if (!PARAM.test(part) || /^\.+$/.test(part)) return undefined;
      params[segment.slice(1)] = part;
    } else if (segment !== part) {
      return undefined;
    }
  }
  return params;
}

/** Strips anything that could make a phone-given name a path. */
export function safeFileName(raw: string | undefined): string {
  let decoded = raw ?? '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep the raw value
  }
  const cleaned = [...decoded]
    .filter((character) => (character.codePointAt(0) ?? 0) >= 0x20 && !'/\\:'.includes(character))
    .join('')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'shared';
}

function sendBytes(response: ServerResponse, file: DeviceFile): void {
  setSecurityHeaders(response);
  response.statusCode = 200;
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ? file.contentType : 'application/octet-stream';
  response.setHeader('Content-Type', type);
  response.setHeader('Content-Length', String(file.bytes.length));
  response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(safeFileName(file.name))}`);
  response.end(file.bytes);
}

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

class SseStream implements DeviceEventStream {
  private readonly listeners: (() => void)[] = [];
  private closed = false;
  private readonly keepalive: NodeJS.Timeout;

  constructor(private readonly response: ServerResponse) {
    this.keepalive = setInterval(() => {
      this.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    this.keepalive.unref();
    response.on('close', () => {
      this.finish();
    });
  }

  send(event: string, data: unknown, id?: string): void {
    const lines = [`event: ${event.replace(/[\r\n]/g, '')}`];
    if (id !== undefined) lines.push(`id: ${id.replace(/[\r\n]/g, '')}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    this.write(`${lines.join('\n')}\n\n`);
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.listeners.push(listener);
  }

  close(): void {
    this.response.end();
    this.finish();
  }

  private write(chunk: string): void {
    if (!this.closed) this.response.write(chunk);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepalive);
    for (const listener of this.listeners.splice(0)) listener();
  }
}

/** The `device.api` capability: routes other plugins add under /m/v1/app/, served after the bridge's auth check. */
export class AppRouter implements DeviceApi {
  private readonly routes: RouteEntry[] = [];
  private readonly uploads: { segments: string[]; handler: (upload: DeviceUpload) => Promise<DeviceApiResponse> }[] = [];
  private readonly streams = new Map<string, StreamOpen>();
  private readonly downloads: { segments: readonly string[]; handler: DownloadHandler }[] = [];
  private readonly open = new Map<string, number>();

  /** `isActive` reads the device list; without it (tests of the router alone) every caller counts as paired. */
  constructor(
    private readonly log: Logger,
    private readonly isActive: (deviceId: string) => Promise<boolean> = async () => true,
  ) {}

  route(method: 'GET' | 'POST', path: string, handler: DeviceApiHandler): void {
    this.routes.push({ method, segments: split(path), handler });
  }

  upload(path: string, handler: (upload: DeviceUpload) => Promise<DeviceApiResponse>): void {
    this.uploads.push({ segments: split(path), handler });
  }

  stream(path: string, open: StreamOpen): void {
    this.streams.set(split(path).join('/'), open);
  }

  download(path: string, handler: DownloadHandler): void {
    this.downloads.push({ segments: split(path), handler });
  }

  async deviceActive(deviceId: string): Promise<boolean> {
    return await this.isActive(deviceId);
  }

  async dispatch(caller: DeviceCaller, path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parts = split(path);
    const key = parts.join('/');
    const method = request.method === 'POST' ? 'POST' : request.method === 'GET' ? 'GET' : undefined;
    if (method === undefined) return sendJson(response, 405, { ok: false });

    const stream = this.streams.get(key);
    if (stream !== undefined && method === 'GET') return this.openStream(caller, stream, request, response);
    if (method === 'POST') {
      for (const entry of this.uploads) {
        const params = match(entry.segments, parts);
        if (params !== undefined) return this.receiveUpload(caller, entry.handler, params, request, response);
      }
    }

    if (method === 'GET') {
      for (const entry of this.downloads) {
        const params = match(entry.segments, parts);
        if (params === undefined) continue;
        const url = new URL(request.url ?? '/', 'http://bridge.local');
        const file = await entry.handler({ caller, params, query: url.searchParams, body: undefined });
        if (file === undefined) return sendJson(response, 404, { ok: false });
        return sendBytes(response, file);
      }
    }

    for (const entry of this.routes) {
      const params = match(entry.segments, parts);
      if (params === undefined) continue;
      if (entry.method !== method) continue;
      let body: unknown;
      if (method === 'POST') {
        const parsed = await readJson(request, MAX_JSON_BYTES);
        if (parsed === 'too_large') return sendJson(response, 413, { ok: false });
        if (parsed === 'bad_json') return sendJson(response, 400, { ok: false, error: 'json' });
        body = parsed.value;
      }
      const url = new URL(request.url ?? '/', 'http://bridge.local');
      const result = await entry.handler({ caller, params, query: url.searchParams, body });
      return sendJson(response, result.status, result.body);
    }
    return sendJson(response, 404, { ok: false });
  }

  private async receiveUpload(
    caller: DeviceCaller,
    handler: (upload: DeviceUpload) => Promise<DeviceApiResponse>,
    params: Record<string, string>,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    for (const name of UPLOAD_HEADERS) {
      const value = headerText(request.headers[name]);
      if (value !== undefined) headers[name] = value.slice(0, 64);
    }
    const declared = Number(headerText(request.headers['content-length']) ?? '0');
    const tooLarge = { ok: false, error: 'too_large', message: '파일이 너무 커요.' };
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return sendJson(response, 413, tooLarge);
    const bytes = await readBody(request, MAX_UPLOAD_BYTES);
    if (bytes === undefined) return sendJson(response, 413, tooLarge);
    if (bytes.length === 0) return sendJson(response, 400, { ok: false, error: 'empty' });
    const type = headerText(request.headers['content-type']) ?? 'application/octet-stream';
    // the device hung up (cancelled) before the answer: work on it can stop
    const gone = new AbortController();
    response.once('close', () => {
      if (!response.writableEnded) gone.abort();
    });
    const result = await handler({
      signal: gone.signal,
      caller,
      name: safeFileName(headerText(request.headers['x-file-name'])),
      contentType: /^[\w.+-]+\/[\w.+-]+$/.test(type.split(';')[0]?.trim() ?? '') ? (type.split(';')[0] ?? '').trim() : 'application/octet-stream',
      bytes,
      params,
      headers,
    });
    return sendJson(response, result.status, result.body);
  }

  private openStream(caller: DeviceCaller, open: StreamOpen, request: IncomingMessage, response: ServerResponse): void {
    const count = this.open.get(caller.deviceId) ?? 0;
    // A phone that reconnects in a loop must not pile up sockets on the Mac.
    if (count >= MAX_STREAMS_PER_DEVICE) return sendJson(response, 429, { ok: false });
    this.open.set(caller.deviceId, count + 1);
    setSecurityHeaders(response);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.write(': open\n\n');
    const stream = new SseStream(response);
    stream.onClose(() => {
      const left = (this.open.get(caller.deviceId) ?? 1) - 1;
      if (left <= 0) this.open.delete(caller.deviceId);
      else this.open.set(caller.deviceId, left);
    });
    const lastEventId = headerText(request.headers['last-event-id']);
    try {
      open(caller, stream, lastEventId);
    } catch (error) {
      this.log.warn('mobile: app stream handler failed', { error: error instanceof Error ? error.name : 'error' });
      stream.close();
    }
  }
}
