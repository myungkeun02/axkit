import { describe, expect, it } from 'vitest';
import { MobileAdmin } from '../../src/mobile/admin.js';
import type { PairingRecord } from '../../src/mobile/admin.js';
import { hashSecret, tokenMatches } from '../../src/mobile/devices.js';
import type { MobileDevice } from '../../src/mobile/devices.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';
import { NOW, patchDevice, seededRandom, wrongCode } from './helpers.js';

function make(now = NOW) {
  const clock = new FakeClock(now);
  const kv = new MapKeyValueStore();
  const admin = new MobileAdmin({ kv, clock, randomBytes: seededRandom(42) });
  return { clock, kv, admin };
}

describe('pairing', () => {
  it('returns a token and a 6-digit code once and stores only their hashes', async () => {
    const { kv, admin } = make();

    const { device, token, pairing } = await admin.pair({ name: '내 아이폰', platform: 'ios' });

    expect(device.id).toMatch(/^d_[A-Z2-7]{8}$/);
    expect(device.name).toBe('내 아이폰');
    expect(device.platform).toBe('ios');
    expect(device.failures).toBe(0);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pairing.code).toMatch(/^\d{6}$/);
    expect(pairing.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Date.parse(pairing.expiresAt)).toBe(NOW.getTime() + 10 * 60_000);

    const devices = (await kv.get<MobileDevice[]>('devices')) ?? [];
    expect(devices).toHaveLength(1);
    expect(devices[0]?.tokenHash).toBe(hashSecret(token));
    expect(JSON.stringify(devices)).not.toContain(token);

    const pairings = (await kv.get<PairingRecord[]>('pairings')) ?? [];
    expect(pairings).toHaveLength(1);
    expect(pairings[0]?.codeHash).toBe(hashSecret(pairing.code));
    expect(pairings[0]?.files).toEqual([]);
    expect('code' in (pairings[0] ?? {})).toBe(false);
  });

  it('accepts the right code once and returns attached files', async () => {
    const { admin } = make();
    const { pairing } = await admin.pair({ name: 'phone', platform: 'android' });
    await admin.attachFiles(pairing.nonce, [
      { name: 'shortcut.shortcut', path: '/tmp/a', contentType: 'application/octet-stream' },
    ]);

    const unlocked = await admin.unlock(pairing.nonce, pairing.code);

    expect(unlocked.status).toBe('ok');
    if (unlocked.status !== 'ok') throw new Error('expected ok');
    expect(unlocked.files.map((file) => file.name)).toEqual(['shortcut.shortcut']);
    expect(unlocked.unlockKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(unlocked.expiresAt).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
    expect((await admin.unlock(pairing.nonce, pairing.code)).status).toBe('expired');
  });

  it('keeps the connection string on the pairing and returns it once on unlock', async () => {
    const { admin } = make();
    const { pairing } = await admin.pair({ name: 'phone', platform: 'ios' });
    const connection = 'https://box.example.ts.net/m/v1/ingest|tok_abc-123';
    await admin.attachFiles(pairing.nonce, [], connection);

    expect((await admin.getPairing(pairing.nonce))?.connection).toBe(connection);
    const unlocked = await admin.unlock(pairing.nonce, pairing.code);

    expect(unlocked.status).toBe('ok');
    if (unlocked.status !== 'ok') throw new Error('expected ok');
    expect(unlocked.connection).toBe(connection);
    expect((await admin.unlock(pairing.nonce, pairing.code)).status).toBe('expired');
  });

  it('leaves the connection string out when the caller does not provide one', async () => {
    const { admin } = make();
    const { pairing } = await admin.pair({ name: 'phone', platform: 'android' });
    await admin.attachFiles(pairing.nonce, []);

    const unlocked = await admin.unlock(pairing.nonce, pairing.code);
    expect(unlocked.status).toBe('ok');
    if (unlocked.status !== 'ok') throw new Error('expected ok');
    expect(unlocked.connection).toBeUndefined();
    expect((await admin.getPairing(pairing.nonce))?.connection).toBeUndefined();
  });

  it('counts wrong codes and burns the pairing on the fifth', async () => {
    const { admin, kv } = make();
    const { pairing } = await admin.pair({ name: 'phone', platform: 'ios' });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await admin.unlock(pairing.nonce, wrongCode(pairing.code));
      expect(result).toEqual({ status: 'wrong', attemptsLeft: 5 - attempt });
    }
    expect(await admin.unlock(pairing.nonce, wrongCode(pairing.code))).toEqual({ status: 'burned' });
    expect(await admin.getPairing(pairing.nonce)).toBeUndefined();
    expect((await kv.get<PairingRecord[]>('pairings')) ?? []).toEqual([]);
  });

  it('expires a pairing after ten minutes', async () => {
    const { admin, clock, kv } = make();
    const { pairing } = await admin.pair({ name: 'phone', platform: 'ios' });

    await clock.advance(10 * 60_000 + 1);

    expect(await admin.getPairing(pairing.nonce)).toBeUndefined();
    expect(await admin.unlock(pairing.nonce, pairing.code)).toEqual({ status: 'expired' });
    expect((await kv.get<PairingRecord[]>('pairings')) ?? []).toEqual([]);
  });

  it('does not attach files after the code was spent', async () => {
    const { admin } = make();
    const { pairing } = await admin.pair({ name: 'phone', platform: 'ios' });
    await admin.unlock(pairing.nonce, pairing.code);

    expect(
      await admin.attachFiles(pairing.nonce, [{ name: 'x', path: '/tmp/x', contentType: 'text/plain' }]),
    ).toBeUndefined();
  });
});

describe('rotation and revocation', () => {
  it('moves the old hash to previous for seven days and clears locks and failures', async () => {
    const { admin, clock, kv } = make();
    const { device, token, pairing } = await admin.pair({ name: 'phone', platform: 'ios' });
    await patchDevice(kv, device.id, { failures: 9, lockedAt: NOW.toISOString() });

    const rotated = await admin.rotate(device.id);

    expect(rotated.token).not.toBe(token);
    expect(rotated.device.lockedAt).toBeUndefined();
    expect(rotated.device.failures).toBe(0);
    expect(rotated.device.previous?.hash).toBe(hashSecret(token));
    expect(rotated.device.previous?.validUntil).toBe(new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
    expect(tokenMatches(rotated.device, hashSecret(rotated.token), NOW)).toBe(true);
    expect(tokenMatches(rotated.device, hashSecret(token), NOW)).toBe(true);
    expect(rotated.pairing.code).toMatch(/^\d{6}$/);

    await clock.advance(8 * 86_400_000);
    const later = await admin.get(device.id);
    expect(later).toBeDefined();
    expect(tokenMatches(later as MobileDevice, hashSecret(token), clock.now())).toBe(false);
    expect(await admin.getPairing(pairing.nonce)).toBeUndefined();
  });

  it('drops both hashes on revoke and revoked devices never match a token', async () => {
    const { admin, kv } = make();
    const { device, token, pairing } = await admin.pair({ name: 'phone', platform: 'ios' });

    await admin.revoke(device.id);
    const revoked = await admin.get(device.id);

    expect(revoked?.tokenHash).toBe('');
    expect(revoked?.previous).toBeUndefined();
    expect(revoked?.revokedAt).toBe(NOW.toISOString());
    expect(tokenMatches(revoked as MobileDevice, hashSecret(token), NOW)).toBe(false);
    expect(await admin.getPairing(pairing.nonce)).toBeUndefined();
    expect((await kv.get<MobileDevice[]>('devices')) ?? []).toHaveLength(1);
  });

  it('lists devices in creation order and refuses unknown ids', async () => {
    const { admin } = make();
    const first = await admin.pair({ name: 'first', platform: 'ios' });
    const second = await admin.pair({ name: 'second', platform: 'android' });

    expect((await admin.list()).map((device) => device.name)).toEqual(['first', 'second']);
    expect((await admin.get(first.device.id))?.name).toBe('first');
    await expect(admin.rotate('d_MISSING')).rejects.toThrow('No such device');
    await expect(admin.revoke(second.device.id)).resolves.toBeUndefined();
  });
});
