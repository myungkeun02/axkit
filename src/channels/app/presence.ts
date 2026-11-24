import type { DeviceCaller } from '../../core/contracts/device-api.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { KeyValueStore } from '../../core/store/types.js';

/** kv row doctor reads from another process: which app clients were seen and whether one holds a live stream. */
export const PRESENCE_KEY = 'presence';
const TOUCH_EVERY_MS = 60_000;

export interface PresenceRecord {
  name: string;
  lastSeenAt: string;
  streams: number;
}

export class Presence {
  private readonly streams = new Map<string, number>();
  private readonly lastWrite = new Map<string, number>();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
  ) {}

  async touch(caller: DeviceCaller): Promise<void> {
    const now = this.clock.now().getTime();
    if (now - (this.lastWrite.get(caller.deviceId) ?? 0) < TOUCH_EVERY_MS) return;
    await this.write(caller);
  }

  async streamOpened(caller: DeviceCaller): Promise<void> {
    this.streams.set(caller.deviceId, (this.streams.get(caller.deviceId) ?? 0) + 1);
    await this.write(caller);
  }

  async streamClosed(caller: DeviceCaller): Promise<void> {
    this.streams.set(caller.deviceId, Math.max(0, (this.streams.get(caller.deviceId) ?? 1) - 1));
    await this.write(caller);
  }

  /** True while this process holds an open stream to the device (the app is on screen): no push needed. */
  hasStream(deviceId: string): boolean {
    return (this.streams.get(deviceId) ?? 0) > 0;
  }

  /** True while any app client holds a live stream: the owner has the app open right now. */
  anyStream(): boolean {
    for (const count of this.streams.values()) if (count > 0) return true;
    return false;
  }

  /** Called on start: nothing is connected to a fresh process. */
  async reset(): Promise<void> {
    const stored = (await this.kv.get<Record<string, PresenceRecord>>(PRESENCE_KEY)) ?? {};
    const cleared = Object.fromEntries(Object.entries(stored).map(([id, record]) => [id, { ...record, streams: 0 }]));
    await this.kv.set(PRESENCE_KEY, cleared);
  }

  private async write(caller: DeviceCaller): Promise<void> {
    const now = this.clock.now();
    this.lastWrite.set(caller.deviceId, now.getTime());
    const stored = (await this.kv.get<Record<string, PresenceRecord>>(PRESENCE_KEY)) ?? {};
    stored[caller.deviceId] = {
      name: caller.deviceName,
      lastSeenAt: now.toISOString(),
      streams: this.streams.get(caller.deviceId) ?? 0,
    };
    await this.kv.set(PRESENCE_KEY, stored);
  }
}
