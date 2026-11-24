import type { Notice } from '../contracts/notify.js';
import type { KeyValueStore } from '../store/types.js';

const DEDUPE_KEY = 'notify.dedupe';
const HOURLY_KEY = 'notify.hourly';
const HOUR_MS = 3_600_000;

/** Dedupe stamps and the rolling hourly per-kind count, both kept in the store so a restart does not reset them. */
export class NoticeAcceptance {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly dedupeMs: number,
  ) {}

  async isDuplicate(notice: Notice, now: number): Promise<boolean> {
    if (notice.dedupeKey === undefined) return false;
    const stamps = (await this.kv.get<Record<string, number>>(DEDUPE_KEY)) ?? {};
    const seenAt = stamps[dedupeId(notice)];
    return seenAt !== undefined && now - seenAt < this.dedupeMs;
  }

  async underCap(notice: Notice, now: number, cap: number): Promise<boolean> {
    if (notice.urgent === true) return true;
    const hourly = await this.readHourly(now);
    return (hourly[notice.kind]?.length ?? 0) < cap;
  }

  /** When the rolling hour frees a slot for this kind again (the oldest stamp ages out). */
  async capFreesAt(kind: string, now: number): Promise<number> {
    const stamps = (await this.readHourly(now))[kind] ?? [];
    return stamps.length === 0 ? now : Math.min(...stamps) + HOUR_MS;
  }

  /** Records a notice as accepted: dedupe stamp plus one entry for the rolling hourly cap. */
  async accept(notice: Notice, now: number): Promise<void> {
    const stored = (await this.kv.get<Record<string, number>>(DEDUPE_KEY)) ?? {};
    const stamps: Record<string, number> = {};
    for (const [key, at] of Object.entries(stored)) {
      if (now - at < this.dedupeMs) stamps[key] = at;
    }
    if (notice.dedupeKey !== undefined) stamps[dedupeId(notice)] = now;
    await this.kv.set(DEDUPE_KEY, stamps);
    const hourly = await this.readHourly(now);
    hourly[notice.kind] = [...(hourly[notice.kind] ?? []), now];
    await this.kv.set(HOURLY_KEY, hourly);
  }

  private async readHourly(now: number): Promise<Record<string, number[]>> {
    const stored = (await this.kv.get<Record<string, number[]>>(HOURLY_KEY)) ?? {};
    const pruned: Record<string, number[]> = {};
    for (const [kind, stamps] of Object.entries(stored)) {
      const recent = stamps.filter((at) => now - at < HOUR_MS);
      if (recent.length > 0) pruned[kind] = recent;
    }
    return pruned;
  }
}

function dedupeId(notice: Notice): string {
  return `${notice.kind}\u0000${notice.dedupeKey ?? ''}`;
}
