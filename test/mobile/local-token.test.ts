import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_DEVICE_ID, isLoopbackAddress, isLoopbackHost, localTokenPath, writeLocalToken,
} from '../../src/mobile/local-token.js';
import { appRoute } from '../../src/mobile/app-routes.js';
import type { BridgeServerDeps } from '../../src/mobile/server.js';
import { bridgeFetch, startBridgeHarness } from './helpers.js';

describe('local desktop token', () => {
  it('writes the token file for this user only (folder 700, file 600) and replaces it atomically', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axkit-local-'));
    try {
      const file = localTokenPath(join(home, '.ax-kit'));
      await writeLocalToken(file, { baseUrl: 'http://127.0.0.1:47617', token: 'first', now: new Date('2026-11-18T00:00:00Z') });
      await writeLocalToken(file, { baseUrl: 'http://127.0.0.1:47617', token: 'second', now: new Date('2026-11-18T00:01:00Z') });
      const body = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      expect(body).toEqual({ v: 1, baseUrl: 'http://127.0.0.1:47617', token: 'second', issuedAt: '2026-11-18T00:01:00.000Z' });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, '.ax-kit'))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('knows loopback addresses and hosts', () => {
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1'].every(isLoopbackAddress)).toBe(true);
    expect(['192.168.0.2', '100.64.0.1', '10.0.0.1', undefined].some(isLoopbackAddress)).toBe(false);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('100.64.0.1')).toBe(false);
  });

  it('lets the local token reach app routes from 127.0.0.1 as the local device, and nothing else', async () => {
    const harness = await startBridgeHarness();
    try {
      harness.app.route('GET', 'whoami', async ({ caller }) => ({ status: 200, body: { ok: true, deviceId: caller.deviceId } }));
      harness.auth.setLocalToken('local-secret');
      const ok = await bridgeFetch(harness, '/m/v1/app/whoami', { headers: { authorization: 'Bearer local-secret' } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, deviceId: LOCAL_DEVICE_ID });
      const wrong = await bridgeFetch(harness, '/m/v1/app/whoami', { headers: { authorization: 'Bearer other' } });
      expect(wrong.status).toBe(401);
      harness.auth.setLocalToken(undefined);
      const off = await bridgeFetch(harness, '/m/v1/app/whoami', { headers: { authorization: 'Bearer local-secret' } });
      expect(off.status).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it('refuses the local token from a network address', async () => {
    const harness = await startBridgeHarness();
    try {
      harness.auth.setLocalToken('local-secret');
      let status = 0;
      let body = '';
      const response = {
        headersSent: false,
        setHeader: () => undefined,
        set statusCode(value: number) { status = value; },
        end: (text: string) => { body = text; },
      } as unknown as ServerResponse;
      const request = { headers: { authorization: 'Bearer local-secret' }, socket: { remoteAddress: '100.64.0.9' } } as unknown as IncomingMessage;
      const deps = { auth: harness.auth, app: harness.app } as unknown as BridgeServerDeps;
      await appRoute(deps, request, response, 'status');
      expect(status).toBe(403);
      expect(JSON.parse(body)).toEqual({ ok: false, error: 'not_local' });
    } finally {
      await harness.close();
    }
  });
});
