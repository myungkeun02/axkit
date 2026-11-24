import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import type { KeyValueStore } from '../core/store/types.js';

export type MobilePlatform = 'ios' | 'android' | 'desktop';

export type RandomBytes = (size: number) => Buffer;

export interface MobileDevice {
  id: string;
  name: string;
  platform: MobilePlatform;
  /** 'app' = the ax-kit phone/desktop app, which may also chat and answer cards. Absent = signal files only. */
  client?: 'app';
  /** The desktop app on this Mac (local token file, loopback only); never stored in the device list. */
  local?: true;
  tokenHash: string;
  /** The token before the last rotation, honored until `validUntil`. */
  previous?: { hash: string; validUntil: string };
  createdAt: string;
  rotatedAt: string;
  lastSeenAt?: string;
  failures: number;
  lockedAt?: string;
  revokedAt?: string;
  rotationRemindedAt?: string;
}

export const DEVICES_KEY = 'devices';
const MAX_DEVICES = 32;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const defaultRandomBytes: RandomBytes = (size) => nodeRandomBytes(size);

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function newToken(random: RandomBytes = defaultRandomBytes): string {
  return random(32).toString('base64url');
}

export function randomString(random: RandomBytes = defaultRandomBytes, size = 16): string {
  return random(size).toString('base64url');
}

export function newDeviceId(random: RandomBytes = defaultRandomBytes): string {
  const bytes = random(8);
  let id = 'd_';
  for (let i = 0; i < 8; i += 1) {
    id += BASE32[(bytes[i] ?? 0) & 31];
  }
  return id;
}

export function newPairingCode(random: RandomBytes = defaultRandomBytes): string {
  const bytes = random(4);
  const value = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
  return String(value % 1_000_000).padStart(6, '0');
}

/** Only revoked devices are dropped, and only when the list is over the cap. */
function bounded(devices: MobileDevice[]): MobileDevice[] {
  if (devices.length <= MAX_DEVICES) return devices;
  const kept = [...devices];
  while (kept.length > MAX_DEVICES) {
    const index = kept.findIndex((device) => device.revokedAt !== undefined);
    kept.splice(index >= 0 ? index : 0, 1);
  }
  return kept;
}

export async function readDevices(kv: KeyValueStore): Promise<MobileDevice[]> {
  const stored = await kv.get<MobileDevice[]>(DEVICES_KEY);
  return Array.isArray(stored) ? stored : [];
}

export async function writeDevices(kv: KeyValueStore, devices: MobileDevice[]): Promise<void> {
  await kv.set(DEVICES_KEY, bounded(devices));
}

export function isActive(device: MobileDevice): boolean {
  return device.revokedAt === undefined;
}

/** Matches the current token or a previous one while its grace period lasts. */
export function tokenMatches(device: MobileDevice, hash: string, now: Date): boolean {
  if (!isActive(device)) return false;
  if (device.tokenHash !== '' && device.tokenHash === hash) return true;
  const previous = device.previous;
  if (previous === undefined || previous.hash !== hash) return false;
  return Date.parse(previous.validUntil) > now.getTime();
}
