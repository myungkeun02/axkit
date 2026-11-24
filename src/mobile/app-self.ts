import type { DeviceApi } from '../core/contracts/device-api.js';
import type { MobileAdmin } from './admin.js';

/**
 * Routes the app uses to manage its own pairing: who am I, a fresh token (the old one keeps working 7 days, so a
 * lost response does not strand the phone), and unpairing from the phone side.
 */
export function registerAppSelfRoutes(
  api: DeviceApi,
  admin: MobileAdmin,
  onRevoked: (deviceId: string) => Promise<void> = async () => undefined,
): void {
  api.route('GET', 'me', async ({ caller }) => {
    const device = await admin.get(caller.deviceId);
    if (device === undefined) return { status: 404, body: { ok: false } };
    return {
      status: 200,
      body: { ok: true, deviceId: device.id, name: device.name, rotatedAt: device.rotatedAt, createdAt: device.createdAt },
    };
  });
  api.route('POST', 'rotate', async ({ caller }) => {
    const result = await admin.rotate(caller.deviceId);
    return { status: 200, body: { ok: true, token: result.token, rotatedAt: result.device.rotatedAt } };
  });
  api.route('POST', 'unpair', async ({ caller }) => {
    await admin.revoke(caller.deviceId);
    await onRevoked(caller.deviceId);
    return { status: 200, body: { ok: true } };
  });
}
