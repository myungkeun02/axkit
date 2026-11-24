import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mobileTexts } from '../../src/mobile/locale.js';
import type { PairingGrant } from '../../src/mobile/admin.js';
import {
  bridgeFetch,
  ingestRequest,
  NOW,
  startBridgeHarness,
  wrongCode,
} from './helpers.js';
import type { BridgeHarness } from './helpers.js';

const texts = mobileTexts('ko');

async function pair(harness: BridgeHarness, name = 'phone'): Promise<{ token: string; pairing: PairingGrant; deviceId: string }> {
  const result = await harness.admin.pair({ name, platform: 'ios' });
  return { token: result.token, pairing: result.pairing, deviceId: result.device.id };
}

function validBody(): Record<string, unknown> {
  return {
    v: 1,
    ts: NOW.toISOString(),
    items: [
      { kind: 'location', lat: 37.5, lng: 127 },
      { kind: 'steps', steps: 1000 },
    ],
  };
}

describe('health and headers', () => {
  it('answers health without authentication and sets security headers', async () => {
    const harness = await startBridgeHarness();
    try {
      const response = await bridgeFetch(harness, '/m/health');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    } finally {
      await harness.close();
    }
  });

  it('returns small 404 and 405 answers', async () => {
    const harness = await startBridgeHarness();
    try {
      const missing = await bridgeFetch(harness, '/nope');
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ ok: false });

      expect((await bridgeFetch(harness, '/m/health', { method: 'POST' })).status).toBe(405);
      expect((await bridgeFetch(harness, '/m/v1/ingest')).status).toBe(405);
    } finally {
      await harness.close();
    }
  });
});

describe('ingest', () => {
  it('accepts an items body and hands it to the ingest pipeline', async () => {
    const harness = await startBridgeHarness();
    try {
      const { token, deviceId } = await pair(harness);

      const response = await bridgeFetch(harness, '/m/v1/ingest', ingestRequest(token, validBody()));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, stored: 2 });
      expect(harness.ingest.calls).toHaveLength(1);
      expect(harness.ingest.calls[0]?.device.id).toBe(deviceId);
      expect(harness.ingest.calls[0]?.items).toHaveLength(2);
      expect((await harness.admin.get(deviceId))?.lastSeenAt).toBe(NOW.toISOString());
    } finally {
      await harness.close();
    }
  });

  it('accepts a flat dictionary and decimal commas', async () => {
    const harness = await startBridgeHarness();
    try {
      const { token } = await pair(harness);

      const response = await bridgeFetch(
        harness,
        '/m/v1/ingest',
        ingestRequest(token, { v: 1, ts: NOW.toISOString(), kind: 'Location', lat: '37,5', lng: '127,1' }),
      );

      expect(response.status).toBe(200);
      expect(harness.ingest.calls[0]?.items[0]).toMatchObject({ kind: 'location', lat: 37.5, lng: 127.1 });
    } finally {
      await harness.close();
    }
  });

  it('rejects missing and unknown tokens without echoing them', async () => {
    const harness = await startBridgeHarness();
    try {
      const missing = await bridgeFetch(harness, '/m/v1/ingest', { method: 'POST', body: '{}' });
      expect(missing.status).toBe(401);
      expect(await missing.text()).toBe('{"ok":false}');

      const unknown = await bridgeFetch(harness, '/m/v1/ingest', ingestRequest('unknown-token', validBody()));
      expect(unknown.status).toBe(401);
      const body = await unknown.text();
      expect(body).not.toContain('unknown-token');
      expect(harness.ingest.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('refuses bodies over 16 KB with 413', async () => {
    const harness = await startBridgeHarness();
    try {
      const { token } = await pair(harness);

      const response = await bridgeFetch(harness, '/m/v1/ingest', ingestRequest(token, 'x'.repeat(17 * 1024)));

      expect(response.status).toBe(413);
      expect(harness.ingest.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('answers empty message text with a localized hint and no failure', async () => {
    const harness = await startBridgeHarness();
    try {
      const { token, deviceId } = await pair(harness);

      const response = await bridgeFetch(
        harness,
        '/m/v1/ingest',
        ingestRequest(token, { v: 1, ts: NOW.toISOString(), kind: 'sms', text: '   ' }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false, problem: texts.emptySms });
      expect(harness.ingest.calls).toHaveLength(0);
      expect((await harness.admin.get(deviceId))?.failures).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('counts stale timestamps and bad JSON as failures', async () => {
    const harness = await startBridgeHarness();
    try {
      const { token, deviceId } = await pair(harness);

      const stale = await bridgeFetch(
        harness,
        '/m/v1/ingest',
        ingestRequest(token, {
          v: 1,
          ts: new Date(NOW.getTime() - 6 * 60_000).toISOString(),
          kind: 'battery',
          level: 50,
        }),
      );
      const badJson = await bridgeFetch(harness, '/m/v1/ingest', ingestRequest(token, '{'));

      expect(stale.status).toBe(400);
      expect(await stale.json()).toEqual({ ok: false, error: 'stale' });
      expect(badJson.status).toBe(400);
      expect(await badJson.json()).toEqual({ ok: false, error: 'json' });
      expect((await harness.admin.get(deviceId))?.failures).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it('locks after ten bad requests, notifies the owner, then answers 423', async () => {
    const harness = await startBridgeHarness();
    try {
      const { token, deviceId } = await pair(harness, '내 아이폰');

      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const response = await bridgeFetch(harness, '/m/v1/ingest', ingestRequest(token, '{'));
        expect(response.status).toBe(400);
      }

      expect(harness.notifier.notices).toHaveLength(1);
      const notice = harness.notifier.notices[0];
      expect(notice?.kind).toBe('phone.device_locked');
      expect(notice?.urgent).toBe(true);
      expect(notice?.text).toContain(deviceId);
      expect(notice?.text).toContain('내 아이폰');
      expect(notice?.text).toContain(`ax-kit phone rotate ${deviceId}`);

      const locked = await bridgeFetch(harness, '/m/v1/ingest', ingestRequest(token, validBody()));
      expect(locked.status).toBe(423);
      expect(await locked.json()).toEqual({ ok: false });
    } finally {
      await harness.close();
    }
  });
});

describe('pairing pages', () => {
  it('shows the form, unlocks with the right code and serves attached files', async () => {
    const harness = await startBridgeHarness();
    const directory = await mkdtemp(join(tmpdir(), 'ax-kit-mobile-'));
    try {
      const { pairing } = await pair(harness);
      const filePath = join(directory, 'shortcut.shortcut');
      await writeFile(filePath, 'shortcut-body');
      await harness.admin.attachFiles(pairing.nonce, [
        { name: 'shortcut.shortcut', path: filePath, contentType: 'application/octet-stream' },
      ]);

      const form = await bridgeFetch(harness, `/m/p/${pairing.nonce}`);
      expect(form.status).toBe(200);
      expect(form.headers.get('content-security-policy')).toContain("default-src 'none'");
      const formHtml = await form.text();
      expect(formHtml).toContain('name="code"');
      expect(formHtml).toContain(texts.pairingHint);

      const submit = await bridgeFetch(harness, `/m/p/${pairing.nonce}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: pairing.code }).toString(),
      });
      expect(submit.status).toBe(200);
      const doneHtml = await submit.text();
      expect(doneHtml).toContain(texts.pairingDoneTitle);
      expect(doneHtml).toContain(`/m/p/${pairing.nonce}/0?k=`);

      const match = /\/m\/p\/[A-Za-z0-9_-]+\/0\?k=([A-Za-z0-9_-]+)/.exec(doneHtml);
      expect(match?.[1]).toBeDefined();
      const download = await bridgeFetch(harness, `/m/p/${pairing.nonce}/0?k=${match?.[1] ?? ''}`);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('shortcut-body');
      expect(download.headers.get('content-type')).toBe('application/octet-stream');
      expect(download.headers.get('content-disposition')).toContain('attachment');
      expect(download.headers.get('content-disposition')).toContain('shortcut.shortcut');
      expect(download.headers.get('cache-control')).toBe('no-store');
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.close();
    }
  });

  it('shows the connection string with a copy button only when one is stored', async () => {
    const harness = await startBridgeHarness();
    try {
      const connection = 'https://box.example.ts.net/m/v1/ingest|tok_abc-123';
      const withString = await pair(harness, 'ios phone');
      await harness.admin.attachFiles(withString.pairing.nonce, [], connection);
      const submit = await bridgeFetch(harness, `/m/p/${withString.pairing.nonce}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: withString.pairing.code }).toString(),
      });
      const html = await submit.text();

      expect(submit.status).toBe(200);
      expect(html).toContain('id="connection"');
      expect(html).toContain(`value="${connection}"`);
      expect(html).toContain('id="copy"');
      expect(html).toContain('<script>');
      expect(submit.headers.get('content-security-policy')).toContain("script-src 'sha256-");

      const plain = await pair(harness, 'android phone');
      await harness.admin.attachFiles(plain.pairing.nonce, []);
      const plainSubmit = await bridgeFetch(harness, `/m/p/${plain.pairing.nonce}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: plain.pairing.code }).toString(),
      });
      const plainHtml = await plainSubmit.text();
      expect(plainHtml).not.toContain('id="connection"');
      expect(plainHtml).not.toContain('<script>');
    } finally {
      await harness.close();
    }
  });

  it('serves the files only for ten minutes after unlocking', async () => {
    const harness = await startBridgeHarness();
    const directory = await mkdtemp(join(tmpdir(), 'ax-kit-mobile-'));
    try {
      const { pairing } = await pair(harness);
      const filePath = join(directory, 'shortcut.shortcut');
      await writeFile(filePath, 'shortcut-body');
      await harness.admin.attachFiles(pairing.nonce, [
        { name: 'shortcut.shortcut', path: filePath, contentType: 'application/octet-stream' },
      ]);
      const unlocked = await harness.admin.unlock(pairing.nonce, pairing.code);
      if (unlocked.status !== 'ok') throw new Error('expected unlock');

      const link = `/m/p/${pairing.nonce}/0?k=${unlocked.unlockKey}`;
      expect((await bridgeFetch(harness, link)).status).toBe(200);

      await harness.clock.advance(10 * 60_000 + 1);

      expect((await bridgeFetch(harness, link)).status).toBe(404);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.close();
    }
  });

  it('answers 404 for a file link with the wrong key', async () => {
    const harness = await startBridgeHarness();
    const directory = await mkdtemp(join(tmpdir(), 'ax-kit-mobile-'));
    try {
      const { pairing } = await pair(harness);
      const filePath = join(directory, 'shortcut.shortcut');
      await writeFile(filePath, 'shortcut-body');
      await harness.admin.attachFiles(pairing.nonce, [
        { name: 'shortcut.shortcut', path: filePath, contentType: 'application/octet-stream' },
      ]);
      await harness.admin.unlock(pairing.nonce, pairing.code);

      const response = await bridgeFetch(harness, `/m/p/${pairing.nonce}/0?k=wrong`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.close();
    }
  });

  it('rejects wrong codes and burns the pairing on the fifth wrong code', async () => {
    const harness = await startBridgeHarness();
    try {
      const { pairing } = await pair(harness);

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await bridgeFetch(harness, `/m/p/${pairing.nonce}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code: wrongCode(pairing.code) }).toString(),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(texts.pairingWrong);
      }

      const burned = await bridgeFetch(harness, `/m/p/${pairing.nonce}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: wrongCode(pairing.code) }).toString(),
      });
      expect(burned.status).toBe(410);
      expect(await burned.text()).toContain(texts.pairingBurned);
    } finally {
      await harness.close();
    }
  });

  it('expires an unused pairing after ten minutes', async () => {
    const harness = await startBridgeHarness();
    try {
      const { pairing } = await pair(harness);
      expect((await bridgeFetch(harness, `/m/p/${pairing.nonce}`)).status).toBe(200);

      await harness.clock.advance(10 * 60_000 + 1);

      const form = await bridgeFetch(harness, `/m/p/${pairing.nonce}`);
      expect(form.status).toBe(410);
      expect(await form.text()).toContain(texts.pairingExpired);
    } finally {
      await harness.close();
    }
  });

  it('caps the code body at 1 KB', async () => {
    const harness = await startBridgeHarness();
    try {
      const { pairing } = await pair(harness);
      const response = await bridgeFetch(harness, `/m/p/${pairing.nonce}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `code=${'1'.repeat(2000)}`,
      });

      expect(response.status).toBe(413);
    } finally {
      await harness.close();
    }
  });
});
