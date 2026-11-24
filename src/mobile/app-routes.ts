import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson, setSecurityHeaders } from './http.js';
import type { BridgeServerDeps } from './server.js';
import { isLoopbackAddress } from './local-token.js';

const MAX_CODE_BYTES = 1024;

export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_') || 'file';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Routes under /m/v1/app/: an app-paired token, then the plugin routes registered on `device.api`. */
export async function appRoute(deps: BridgeServerDeps, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  const auth = await deps.auth.authenticate(request.headers.authorization);
  if (auth.status === 'unauthorized') return sendJson(response, 401, { ok: false });
  if (auth.status === 'locked') return sendJson(response, 423, { ok: false });
  if (auth.status === 'rate_limited') return sendJson(response, 429, { ok: false });
  // Tokens baked into MacroDroid or Shortcut files only send signals; chatting and approving need the app pairing.
  if (auth.device.client !== 'app') return sendJson(response, 403, { ok: false, error: 'not_app' });
  // The local desktop token works on this Mac only: a request that reached us over the network is refused.
  if (auth.device.local === true && !isLoopbackAddress(request.socket.remoteAddress)) {
    return sendJson(response, 403, { ok: false, error: 'not_local' });
  }
  await deps.auth.recordSuccess(auth.device);
  await deps.app.dispatch(
    { deviceId: auth.device.id, deviceName: auth.device.name, platform: auth.device.platform },
    rest,
    request,
    response,
  );
}

/** The app trades the one-time code from the QR for its token; the same five-try rule as the web page applies. */
export async function appPairRoute(deps: BridgeServerDeps, request: IncomingMessage, response: ServerResponse, nonce: string): Promise<void> {
  const parsed = await readJson(request, MAX_CODE_BYTES);
  if (typeof parsed !== 'object') return sendJson(response, 400, { ok: false, error: 'json' });
  const body = parsed.value;
  const code = typeof body === 'object' && body !== null ? String((body as Record<string, unknown>)['code'] ?? '') : '';
  const record = await deps.admin.getPairing(nonce);
  const device = record === undefined ? undefined : await deps.admin.get(record.deviceId);
  if (record === undefined || device?.client !== 'app' || record.connection === undefined) {
    return sendJson(response, 410, { ok: false, error: 'expired' });
  }
  const result = await deps.admin.unlock(nonce, code);
  if (result.status === 'wrong') return sendJson(response, 403, { ok: false, error: 'wrong', attemptsLeft: result.attemptsLeft });
  if (result.status !== 'ok' || result.connection === undefined) {
    return sendJson(response, 410, { ok: false, error: result.status === 'burned' ? 'burned' : 'expired' });
  }
  const cut = result.connection.lastIndexOf('|');
  return sendJson(response, 200, {
    ok: true,
    deviceId: result.deviceId,
    deviceName: device.name,
    baseUrl: result.connection.slice(0, cut),
    token: result.connection.slice(cut + 1),
  });
}

export async function apkRoute(deps: BridgeServerDeps, response: ServerResponse, nonce: string): Promise<void> {
  const link = await deps.apk?.find(nonce);
  if (link === undefined) return sendJson(response, 404, { ok: false });
  let data: Buffer;
  try {
    data = await readFile(link.path);
  } catch {
    return sendJson(response, 404, { ok: false });
  }
  setSecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/vnd.android.package-archive');
  response.setHeader('Content-Disposition', contentDisposition('ax-kit.apk'));
  response.setHeader('Content-Length', String(data.length));
  response.end(data);
}

