import { describe, expect, it } from 'vitest';
import { MobileAdmin } from '../../src/mobile/admin.js';
import { AuthGate } from '../../src/mobile/auth.js';
import type { MobileDevice } from '../../src/mobile/devices.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';
import { NOW, patchDevice, seededRandom } from './helpers.js';

function make() {
  const clock = new FakeClock(NOW);
  const kv = new MapKeyValueStore();
  const admin = new MobileAdmin({ kv, clock, randomBytes: seededRandom(5) });
  const locked: MobileDevice[] = [];
  const gate = new AuthGate({
    kv,
    clock,
    log: silentLogger,
    onLocked: async (device) => {
      locked.push(device);
    },
  });
  return { clock, kv, admin, gate, locked };
}

const bearer = (token: string): string => `Bearer ${token}`;

describe('token authentication', () => {
  it('accepts the current token and rejects missing or unknown ones', async () => {
    const { admin, gate } = make();
    const { token } = await admin.pair({ name: 'phone', platform: 'ios' });

    expect((await gate.authenticate(bearer(token))).status).toBe('ok');
    expect((await gate.authenticate(undefined)).status).toBe('unauthorized');
    expect((await gate.authenticate('Bearer not-a-token')).status).toBe('unauthorized');
    expect((await gate.authenticate('Basic abc')).status).toBe('unauthorized');
  });

  it('accepts the previous token inside seven days and rejects it after', async () => {
    const { admin, gate, clock } = make();
    const { device, token } = await admin.pair({ name: 'phone', platform: 'ios' });
    await admin.rotate(device.id);

    expect((await gate.authenticate(bearer(token))).status).toBe('ok');

    await clock.advance(8 * 86_400_000);
    expect((await gate.authenticate(bearer(token))).status).toBe('unauthorized');
  });

  it('rejects a revoked device even with the old token', async () => {
    const { admin, gate } = make();
    const { device, token } = await admin.pair({ name: 'phone', platform: 'ios' });
    await admin.revoke(device.id);

    expect((await gate.authenticate(bearer(token))).status).toBe('unauthorized');
  });

  it('answers 423 for a locked device', async () => {
    const { admin, gate, kv } = make();
    const { device, token } = await admin.pair({ name: 'phone', platform: 'ios' });
    await patchDevice(kv, device.id, { lockedAt: NOW.toISOString() });

    expect((await gate.authenticate(bearer(token))).status).toBe('locked');
  });
});

describe('rate limits', () => {
  it('allows 60 requests per rolling minute and rejects the 61st', async () => {
    const { admin, gate, clock } = make();
    const { token } = await admin.pair({ name: 'phone', platform: 'ios' });

    for (let request = 1; request <= 60; request += 1) {
      expect((await gate.authenticate(bearer(token))).status).toBe('ok');
    }
    expect((await gate.authenticate(bearer(token))).status).toBe('rate_limited');

    await clock.advance(61_000);
    expect((await gate.authenticate(bearer(token))).status).toBe('ok');
  });

  it('blocks unknown tokens for ten minutes after 20 failures without blocking valid tokens', async () => {
    const { admin, gate, clock } = make();
    const { token } = await admin.pair({ name: 'phone', platform: 'ios' });

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await gate.authenticate('Bearer wrong')).status).toBe('unauthorized');
    }
    expect((await gate.authenticate('Bearer wrong')).status).toBe('rate_limited');
    expect((await gate.authenticate(bearer(token))).status).toBe('ok');
    expect((await gate.authenticate('Bearer another')).status).toBe('rate_limited');

    await clock.advance(10 * 60_000 + 1);
    expect((await gate.authenticate('Bearer wrong')).status).toBe('unauthorized');
  });
});

describe('failure lockout', () => {
  it('locks after ten failures in a row and calls the notice once', async () => {
    const { admin, gate, kv, locked } = make();
    const { device, token } = await admin.pair({ name: 'phone', platform: 'ios' });

    for (let failure = 1; failure < 10; failure += 1) {
      await gate.recordFailure(device);
      expect((await admin.get(device.id))?.lockedAt).toBeUndefined();
    }
    expect(locked).toHaveLength(0);
    await gate.recordFailure(device);

    expect(locked).toHaveLength(1);
    expect(locked[0]?.id).toBe(device.id);
    const stored = await admin.get(device.id);
    expect(stored?.failures).toBe(10);
    expect(stored?.lockedAt).toBe(NOW.toISOString());
    expect((await gate.authenticate(bearer(token))).status).toBe('locked');
    expect((await kv.get<MobileDevice[]>('devices'))?.[0]?.failures).toBe(10);
  });

  it('resets the failure count and records lastSeenAt after a good request', async () => {
    const { admin, gate, clock, locked } = make();
    const { device, token } = await admin.pair({ name: 'phone', platform: 'ios' });

    await gate.recordFailure(device);
    await gate.recordFailure(device);
    await gate.recordFailure(device);
    await gate.recordSuccess(device);
    const afterSuccess = await admin.get(device.id);
    expect(afterSuccess?.failures).toBe(0);
    expect(afterSuccess?.lastSeenAt).toBe(NOW.toISOString());

    await clock.advance(60_000);
    for (let failure = 0; failure < 9; failure += 1) await gate.recordFailure(device);
    expect(locked).toHaveLength(0);
    expect((await admin.get(device.id))?.failures).toBe(9);
    expect((await gate.authenticate(bearer(token))).status).toBe('ok');
  });
});
