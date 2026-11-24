import type { Clock } from '../core/scheduler/types.js';
import type { KeyValueStore } from '../core/store/types.js';
import type { RandomBytes } from './devices.js';
import { defaultRandomBytes, randomString } from './devices.js';

export const APK_LINKS_KEY = 'apkLinks';
const LINK_TTL_MS = 30 * 60_000;
const MAX_LINKS = 10;

export interface ApkLink {
  nonce: string;
  path: string;
  expiresAt: string;
}

/**
 * Short-lived download links for the app's APK, so the phone can install it from a QR code. The APK holds no secret,
 * but the link still expires so the public path does not serve files forever.
 */
export class ApkLinks {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
    private readonly random: RandomBytes = defaultRandomBytes,
  ) {}

  async create(path: string): Promise<ApkLink> {
    const now = this.clock.now();
    const link: ApkLink = {
      nonce: randomString(this.random, 16),
      path,
      expiresAt: new Date(now.getTime() + LINK_TTL_MS).toISOString(),
    };
    await this.kv.set(APK_LINKS_KEY, [...(await this.fresh(now)), link].slice(-MAX_LINKS));
    return link;
  }

  async find(nonce: string): Promise<ApkLink | undefined> {
    return (await this.fresh(this.clock.now())).find((link) => link.nonce === nonce);
  }

  private async fresh(now: Date): Promise<ApkLink[]> {
    const stored = await this.kv.get<ApkLink[]>(APK_LINKS_KEY);
    return (Array.isArray(stored) ? stored : []).filter((link) => Date.parse(link.expiresAt) > now.getTime());
  }
}
