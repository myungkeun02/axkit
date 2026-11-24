import type { Logger } from '../core/log/types.js';
import type { Clock } from '../core/scheduler/types.js';
import type { KeyValueStore } from '../core/store/types.js';
import type { MobileDevice } from './devices.js';
import { hashSecret, readDevices, tokenMatches, writeDevices } from './devices.js';
import { LOCAL_DEVICE_ID, LOCAL_DEVICE_NAME } from './local-token.js';
import { SlidingWindow } from './limits.js';

export type AuthResult =
  | { status: 'ok'; device: MobileDevice }
  | { status: 'unauthorized' }
  | { status: 'locked'; device: MobileDevice }
  | { status: 'rate_limited' };

export interface AuthGateOptions {
  kv: KeyValueStore;
  clock: Clock;
  log: Logger;
  /** Called once when a device reaches the failure threshold. */
  onLocked?: (device: MobileDevice) => Promise<void>;
}

const TOKEN_LIMIT = 60;
/** D3: the desktop app on this Mac (loopback only) reads a dashboard of ~10 views and polls; it gets more room. */
const LOCAL_LIMIT = 240;
const TOKEN_WINDOW_MS = 60_000;
const UNKNOWN_LIMIT = 20;
const UNKNOWN_WINDOW_MS = 10 * 60_000;
const LOCK_THRESHOLD = 10;
const MAX_TOKEN_LENGTH = 512;

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (token === undefined || token.length > MAX_TOKEN_LENGTH) return undefined;
  return token;
}

/** Token authentication, per-device request limits and the lockout after repeated bad requests. */
export class AuthGate {
  private readonly kv: KeyValueStore;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly onLocked: ((device: MobileDevice) => Promise<void>) | undefined;
  private readonly requests = new SlidingWindow(TOKEN_WINDOW_MS, TOKEN_LIMIT);
  private readonly localRequests = new SlidingWindow(TOKEN_WINDOW_MS, LOCAL_LIMIT);
  private readonly unknown = new SlidingWindow(UNKNOWN_WINDOW_MS, UNKNOWN_LIMIT);
  private unknownBlockedUntil = 0;
  private localHash: string | undefined;
  private localSince = '';

  constructor(options: AuthGateOptions) {
    this.kv = options.kv;
    this.clock = options.clock;
    this.log = options.log;
    this.onLocked = options.onLocked;
  }

  /** The desktop app's local token (rotated on every start; `undefined` turns it off). Only the hash is kept. */
  setLocalToken(token: string | undefined): void {
    this.localHash = token === undefined ? undefined : hashSecret(token);
    this.localSince = this.clock.now().toISOString();
  }

  async authenticate(header: string | undefined): Promise<AuthResult> {
    const now = this.clock.now();
    const token = bearerToken(header);
    if (token === undefined) return this.unknownToken(now);
    const hash = hashSecret(token);
    if (this.localHash !== undefined && hash === this.localHash) {
      if (this.localRequests.over(`device:${LOCAL_DEVICE_ID}`, now)) return { status: 'rate_limited' };
      const device: MobileDevice = {
        id: LOCAL_DEVICE_ID, name: LOCAL_DEVICE_NAME, platform: 'desktop', client: 'app', local: true,
        tokenHash: this.localHash, createdAt: this.localSince, rotatedAt: this.localSince, failures: 0,
      };
      return { status: 'ok', device };
    }
    const device = (await readDevices(this.kv)).find((candidate) => tokenMatches(candidate, hash, now));
    if (device === undefined) return this.unknownToken(now);
    if (device.lockedAt !== undefined) return { status: 'locked', device };
    if (this.requests.over(`device:${device.id}`, now)) {
      this.log.warn('mobile: device rate limit reached', { deviceId: device.id });
      return { status: 'rate_limited' };
    }
    return { status: 'ok', device };
  }

  async recordSuccess(device: MobileDevice): Promise<void> {
    const now = this.clock.now();
    const devices = await readDevices(this.kv);
    const index = devices.findIndex((candidate) => candidate.id === device.id);
    const current = devices[index];
    if (index < 0 || current === undefined || current.revokedAt !== undefined) return;
    devices[index] = { ...current, failures: 0, lastSeenAt: now.toISOString() };
    await writeDevices(this.kv, devices);
  }

  async recordFailure(device: MobileDevice): Promise<void> {
    const now = this.clock.now();
    const devices = await readDevices(this.kv);
    const index = devices.findIndex((candidate) => candidate.id === device.id);
    const current = devices[index];
    if (index < 0 || current === undefined || current.revokedAt !== undefined) return;
    const failures = current.failures + 1;
    const locks = failures >= LOCK_THRESHOLD && current.lockedAt === undefined;
    const updated: MobileDevice = locks
      ? { ...current, failures, lockedAt: now.toISOString() }
      : { ...current, failures };
    devices[index] = updated;
    await writeDevices(this.kv, devices);
    if (locks && this.onLocked !== undefined) {
      await this.onLocked(updated).catch((error: unknown) => {
        this.log.warn('mobile: lock notice failed', { error: error instanceof Error ? error.name : 'error' });
      });
    }
  }

  private unknownToken(now: Date): AuthResult {
    if (now.getTime() < this.unknownBlockedUntil) return { status: 'rate_limited' };
    if (this.unknown.over('unknown', now)) {
      this.unknownBlockedUntil = now.getTime() + UNKNOWN_WINDOW_MS;
      this.unknown.clear();
      this.log.warn('mobile: unknown-token rate limit reached');
      return { status: 'rate_limited' };
    }
    return { status: 'unauthorized' };
  }
}
