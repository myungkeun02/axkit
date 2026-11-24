import { timingSafeEqual } from 'node:crypto';
import type { Clock } from '../core/scheduler/types.js';
import type { KeyValueStore } from '../core/store/types.js';
import type { MobileDevice, MobilePlatform, RandomBytes } from './devices.js';
import {
  defaultRandomBytes,
  hashSecret,
  isActive,
  newDeviceId,
  newPairingCode,
  newToken,
  randomString,
  readDevices,
  writeDevices,
} from './devices.js';

export interface PairingFile {
  name: string;
  path: string;
  contentType: string;
}

export interface PairingRecord {
  nonce: string;
  codeHash: string;
  deviceId: string;
  expiresAt: string;
  attempts: number;
  files: PairingFile[];
  /** `<ingest url>|<token>` shown once on the phone done page; holds a token, so it never leaves this record. */
  connection?: string;
  unlockKey?: string;
  unlockedUntil?: string;
  usedAt?: string;
}

export interface PairingGrant {
  nonce: string;
  /** Returned once; only the hash is stored. */
  code: string;
  expiresAt: string;
  deviceId: string;
}

export interface PairingResult {
  device: MobileDevice;
  /** Returned once; only the hash is stored. */
  token: string;
  pairing: PairingGrant;
}

export type UnlockResult =
  | {
      status: 'ok';
      nonce: string;
      deviceId: string;
      files: PairingFile[];
      unlockKey: string;
      expiresAt: string;
      connection?: string;
    }
  | { status: 'wrong'; attemptsLeft: number }
  | { status: 'expired' }
  | { status: 'burned' };

export const PAIRINGS_KEY = 'pairings';
const PAIRING_TTL_MS = 10 * 60_000;
const UNLOCK_TTL_MS = 10 * 60_000;
const PREVIOUS_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_PAIRINGS = 50;

export interface MobileAdminOptions {
  kv: KeyValueStore;
  clock: Clock;
  randomBytes?: RandomBytes;
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function asIso(date: Date): string {
  return date.toISOString();
}

/** Device registry and pairing codes. Every read goes to kv because the CLI writes it from another process. */
export class MobileAdmin {
  private readonly kv: KeyValueStore;
  private readonly clock: Clock;
  private readonly random: RandomBytes;

  constructor(options: MobileAdminOptions) {
    this.kv = options.kv;
    this.clock = options.clock;
    this.random = options.randomBytes ?? defaultRandomBytes;
  }

  async pair(input: { name: string; platform: MobilePlatform; client?: 'app' }): Promise<PairingResult> {
    const name = input.name.trim().slice(0, 60);
    if (name === '') throw new Error('Device name is required');
    const now = this.clock.now();
    const devices = await readDevices(this.kv);
    let id = newDeviceId(this.random);
    while (devices.some((device) => device.id === id)) id = newDeviceId(this.random);
    const token = newToken(this.random);
    const device: MobileDevice = {
      id,
      name,
      platform: input.platform,
      ...(input.client !== undefined ? { client: input.client } : {}),
      tokenHash: hashSecret(token),
      createdAt: asIso(now),
      rotatedAt: asIso(now),
      failures: 0,
    };
    await writeDevices(this.kv, [...devices, device]);
    const pairing = await this.createPairing(id, now);
    return { device, token, pairing };
  }

  async rotate(deviceId: string): Promise<PairingResult> {
    const now = this.clock.now();
    const devices = await readDevices(this.kv);
    const index = devices.findIndex((device) => device.id === deviceId);
    const current = devices[index];
    if (index < 0 || current === undefined) throw new Error(`No such device: ${deviceId}`);
    if (!isActive(current)) throw new Error(`Device is revoked: ${deviceId}`);
    const token = newToken(this.random);
    const rotated: MobileDevice = {
      ...current,
      tokenHash: hashSecret(token),
      previous: { hash: current.tokenHash, validUntil: asIso(new Date(now.getTime() + PREVIOUS_TTL_MS)) },
      rotatedAt: asIso(now),
      failures: 0,
    };
    delete rotated.lockedAt;
    devices[index] = rotated;
    await writeDevices(this.kv, devices);
    const pairing = await this.createPairing(deviceId, now);
    return { device: rotated, token, pairing };
  }

  async revoke(deviceId: string): Promise<void> {
    const now = this.clock.now();
    const devices = await readDevices(this.kv);
    const index = devices.findIndex((device) => device.id === deviceId);
    const current = devices[index];
    if (index < 0 || current === undefined) throw new Error(`No such device: ${deviceId}`);
    const revoked: MobileDevice = {
      ...current,
      tokenHash: '',
      revokedAt: current.revokedAt ?? asIso(now),
      failures: 0,
    };
    delete revoked.previous;
    delete revoked.lockedAt;
    devices[index] = revoked;
    await writeDevices(this.kv, devices);
    const pairings = (await this.readPairings(now)).filter((record) => record.deviceId !== deviceId);
    await this.writePairings(pairings);
  }

  async list(): Promise<MobileDevice[]> {
    return [...(await readDevices(this.kv))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<MobileDevice | undefined> {
    return (await readDevices(this.kv)).find((device) => device.id === id);
  }

  async getPairing(nonce: string): Promise<PairingRecord | undefined> {
    const now = this.clock.now();
    return (await this.readPairings(now)).find((record) => record.nonce === nonce);
  }

  async attachFiles(
    nonce: string,
    files: PairingFile[],
    connection?: string,
  ): Promise<PairingRecord | undefined> {
    const now = this.clock.now();
    const records = await this.readPairings(now);
    const index = records.findIndex((record) => record.nonce === nonce);
    const current = records[index];
    if (index < 0 || current === undefined || current.usedAt !== undefined) return undefined;
    const updated: PairingRecord = {
      ...current,
      files: files.map((file) => ({
        name: file.name.slice(0, 200),
        path: file.path,
        contentType: file.contentType,
      })),
      ...(connection !== undefined && connection.length > 0
        ? { connection: connection.slice(0, 500) }
        : {}),
    };
    records[index] = updated;
    await this.writePairings(records);
    return updated;
  }

  /** One-time: a successful unlock spends the code. Five wrong codes burn the pairing. */
  async unlock(nonce: string, code: string): Promise<UnlockResult> {
    const now = this.clock.now();
    const records = await this.readPairings(now);
    const index = records.findIndex((record) => record.nonce === nonce);
    const current = records[index];
    if (index < 0 || current === undefined) return { status: 'expired' };
    if (current.usedAt !== undefined) return { status: 'expired' };
    if (!sameHash(hashSecret(code.trim()), current.codeHash)) {
      const attempts = current.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        records.splice(index, 1);
        await this.writePairings(records);
        return { status: 'burned' };
      }
      records[index] = { ...current, attempts };
      await this.writePairings(records);
      return { status: 'wrong', attemptsLeft: MAX_ATTEMPTS - attempts };
    }
    const unlockKey = randomString(this.random, 16);
    const unlockedUntil = asIso(new Date(now.getTime() + UNLOCK_TTL_MS));
    const updated: PairingRecord = { ...current, unlockKey, unlockedUntil, usedAt: asIso(now) };
    records[index] = updated;
    await this.writePairings(records);
    return {
      status: 'ok',
      nonce,
      deviceId: updated.deviceId,
      files: updated.files,
      unlockKey,
      expiresAt: unlockedUntil,
      ...(updated.connection !== undefined ? { connection: updated.connection } : {}),
    };
  }

  /** A file link only works after an unlock, with the matching key, before the unlock window ends. */
  async file(nonce: string, index: number, key: string, now = this.clock.now()): Promise<PairingFile | undefined> {
    if (!Number.isInteger(index) || index < 0) return undefined;
    const record = (await this.readPairings(now)).find((candidate) => candidate.nonce === nonce);
    if (record?.unlockKey === undefined || record.unlockedUntil === undefined) return undefined;
    if (Date.parse(record.unlockedUntil) <= now.getTime()) return undefined;
    if (!sameHash(record.unlockKey, key)) return undefined;
    return record.files[index];
  }

  async prune(now = this.clock.now()): Promise<{ pairings: number; previous: number }> {
    const beforePairings = (await this.kv.get<PairingRecord[]>(PAIRINGS_KEY)) ?? [];
    const keptPairings = await this.readPairings(now);
    const devices = await readDevices(this.kv);
    let previous = 0;
    const keptDevices = devices.map((device) => {
      if (device.previous === undefined || Date.parse(device.previous.validUntil) > now.getTime()) return device;
      const kept = { ...device };
      delete kept.previous;
      previous += 1;
      return kept;
    });
    if (previous > 0) await writeDevices(this.kv, keptDevices);
    return { pairings: beforePairings.length - keptPairings.length, previous };
  }

  async markRotationReminded(deviceId: string, now = this.clock.now()): Promise<void> {
    const devices = await readDevices(this.kv);
    const index = devices.findIndex((device) => device.id === deviceId);
    const current = devices[index];
    if (index < 0 || current === undefined) return;
    devices[index] = { ...current, rotationRemindedAt: asIso(now) };
    await writeDevices(this.kv, devices);
  }

  private async createPairing(deviceId: string, now: Date): Promise<PairingGrant> {
    const code = newPairingCode(this.random);
    const record: PairingRecord = {
      nonce: randomString(this.random, 16),
      codeHash: hashSecret(code),
      deviceId,
      expiresAt: asIso(new Date(now.getTime() + PAIRING_TTL_MS)),
      attempts: 0,
      files: [],
    };
    const records = await this.readPairings(now);
    await this.writePairings([...records, record].slice(-MAX_PAIRINGS));
    return { nonce: record.nonce, code, expiresAt: record.expiresAt, deviceId };
  }

  private async readPairings(now: Date): Promise<PairingRecord[]> {
    const stored = await this.kv.get<PairingRecord[]>(PAIRINGS_KEY);
    const records = Array.isArray(stored) ? stored : [];
    const fresh = records.filter((record) => Date.parse(record.expiresAt) > now.getTime());
    if (fresh.length !== records.length) await this.writePairings(fresh);
    return fresh;
  }

  private writePairings(records: PairingRecord[]): Promise<void> {
    return this.kv.set(PAIRINGS_KEY, records);
  }
}
