import { describe, expect, it } from 'vitest';
import { Contracts } from '../../src/core/contracts/index.js';
import { MobileAdmin } from '../../src/mobile/admin.js';
import type { PairingRecord } from '../../src/mobile/admin.js';
import { DEFAULT_HOST, DEFAULT_PORT, pairingUrl, resolveMobileConfig } from '../../src/mobile/config.js';
import { MAINTENANCE_JOB, mobileBridge } from '../../src/mobile/index.js';
import type { MobileDevice } from '../../src/mobile/devices.js';
import { createTestContext } from '../support/context.js';
import { FakeNotifier, NOW, patchDevice, seededRandom } from './helpers.js';

const DAY_MS = 86_400_000;

async function setup() {
  const notifier = new FakeNotifier();
  const context = createTestContext({
    now: NOW,
    capabilities: { [Contracts.notifier.id]: notifier },
  });
  await mobileBridge({ listen: false }).setup(context.ctx);
  const admin = new MobileAdmin({ kv: context.kv, clock: context.clock, randomBytes: seededRandom(21) });
  return { context, notifier, admin };
}

describe('mobile.maintenance', () => {
  it('registers the daily job, both capabilities and the choice handler', async () => {
    const { context } = await setup();

    expect(context.scheduler.jobs.get(MAINTENANCE_JOB)?.schedule).toEqual({ kind: 'daily', at: '09:30' });
    expect(context.provided.get(Contracts.phoneSignals.id)).toBeDefined();
    expect(context.provided.get(Contracts.phoneOtp.id)).toBeDefined();
    expect(context.handlers.some((handler) => handler.id === 'mobile.sms_action')).toBe(true);
  });

  it('suggests a rotation for a connection older than ninety days, once', async () => {
    const { context, notifier, admin } = await setup();
    const { device } = await admin.pair({ name: '내 아이폰', platform: 'ios' });
    await patchDevice(context.kv, device.id, {
      rotatedAt: new Date(NOW.getTime() - 91 * DAY_MS).toISOString(),
    });

    await context.scheduler.run(MAINTENANCE_JOB, NOW);

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.kind).toBe('phone.rotate_reminder');
    expect(notifier.notices[0]?.text).toContain(device.id);
    expect(notifier.notices[0]?.text).toContain(`ax-kit phone rotate ${device.id}`);
    expect((await admin.get(device.id))?.rotationRemindedAt).toBe(NOW.toISOString());

    await context.scheduler.run(MAINTENANCE_JOB, NOW);
    expect(notifier.notices).toHaveLength(1);
  });

  it('stays quiet before ninety days and after a recent reminder', async () => {
    const { context, notifier, admin } = await setup();
    const young = await admin.pair({ name: 'young', platform: 'ios' });
    await patchDevice(context.kv, young.device.id, {
      rotatedAt: new Date(NOW.getTime() - 89 * DAY_MS).toISOString(),
    });
    const reminded = await admin.pair({ name: 'reminded', platform: 'ios' });
    await patchDevice(context.kv, reminded.device.id, {
      rotatedAt: new Date(NOW.getTime() - 100 * DAY_MS).toISOString(),
      rotationRemindedAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString(),
    });

    await context.scheduler.run(MAINTENANCE_JOB, NOW);

    expect(notifier.notices).toHaveLength(0);
  });

  it('does not suggest rotation for revoked devices', async () => {
    const { context, notifier, admin } = await setup();
    const { device } = await admin.pair({ name: 'old', platform: 'ios' });
    await patchDevice(context.kv, device.id, {
      rotatedAt: new Date(NOW.getTime() - 200 * DAY_MS).toISOString(),
    });
    await admin.revoke(device.id);

    await context.scheduler.run(MAINTENANCE_JOB, NOW);

    expect(notifier.notices).toHaveLength(0);
  });

  it('drops expired pairings and expired previous hashes', async () => {
    const { context, admin } = await setup();
    const { device } = await admin.pair({ name: 'phone', platform: 'ios' });
    await admin.rotate(device.id);
    await patchDevice(context.kv, device.id, {
      previous: { hash: 'old', validUntil: new Date(NOW.getTime() - 1000).toISOString() },
    });
    await context.clock.advance(11 * 60_000);

    await context.scheduler.run(MAINTENANCE_JOB, context.clock.now());

    expect(((await context.kv.get<PairingRecord[]>('pairings')) ?? []).length).toBe(0);
    const stored = (await context.kv.get<MobileDevice[]>('devices')) ?? [];
    expect(stored[0]?.previous).toBeUndefined();
  });
});

describe('mobile config', () => {
  it('defaults to loopback on the bridge port', () => {
    expect(resolveMobileConfig({})).toEqual({
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      forcedLoopback: false,
      usedDefaults: false,
    });
  });

  it('refuses to listen on all interfaces', () => {
    const config = resolveMobileConfig({ host: '0.0.0.0', port: '5000' });

    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.port).toBe(5000);
    expect(config.forcedLoopback).toBe(true);
  });

  it('uses defaults for invalid config and builds pairing links', () => {
    expect(resolveMobileConfig({ port: 99_999 })).toMatchObject({ port: DEFAULT_PORT, usedDefaults: true });

    expect(pairingUrl({ host: '127.0.0.1', port: 47617 }, 'abc')).toBe('http://127.0.0.1:47617/m/p/abc');
    expect(pairingUrl({ host: '127.0.0.1', port: 47617, publicUrl: 'https://example.ts.net/' }, 'abc')).toBe(
      'https://example.ts.net/m/p/abc',
    );
  });
});
