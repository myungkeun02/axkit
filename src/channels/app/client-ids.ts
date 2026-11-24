import type { KeyValueStore } from '../../core/store/types.js';

const KEY = 'client-ids';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IDS = 1_000;

type Stored = Record<string, { seq: number; at: number }>;

/**
 * The app's `clientId` on a sent message: a resend (lost response, reconnect, restart in between) maps to the first
 * message instead of a second one. The id is claimed before anything is awaited, so two copies arriving together
 * still make one message; ids are kept for a day across restarts.
 */
export class ClientIds {
  private readonly claimed = new Map<string, Promise<number | undefined>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date,
  ) {}

  /** Runs `create` once per id; a resend gets the first message's seq with `duplicate: true`. */
  async once(id: string, create: () => Promise<number>): Promise<{ seq: number; duplicate: boolean }> {
    const earlier = this.claimed.get(id);
    if (earlier !== undefined) {
      const seq = await earlier;
      // the first copy failed before storing anything: this one may try
      return seq !== undefined ? { seq, duplicate: true } : await this.once(id, create);
    }
    const work = (async (): Promise<{ seq: number; duplicate: boolean }> => {
      const old = await this.lookup(id);
      if (old !== undefined) return { seq: old, duplicate: true };
      const seq = await create();
      await this.save(id, seq).catch(() => undefined);
      return { seq, duplicate: false };
    })();
    this.claimed.set(
      id,
      work.then(
        (result) => result.seq,
        () => {
          this.claimed.delete(id);
          return undefined;
        },
      ),
    );
    if (this.claimed.size > MAX_IDS) this.claimed.delete(this.claimed.keys().next().value ?? '');
    return await work;
  }

  private async stored(): Promise<Stored> {
    const value = await this.kv.get<unknown>(KEY);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Stored) : {};
  }

  private async lookup(id: string): Promise<number | undefined> {
    const entry = (await this.stored().catch((): Stored => ({})))[id];
    return entry !== undefined && this.now().getTime() - entry.at <= TTL_MS ? entry.seq : undefined;
  }

  private save(id: string, seq: number): Promise<void> {
    const next = this.chain.then(async () => {
      const now = this.now().getTime();
      const kept = Object.entries(await this.stored()).filter(([, entry]) => now - entry.at <= TTL_MS).slice(-MAX_IDS);
      await this.kv.set(KEY, { ...Object.fromEntries(kept), [id]: { seq, at: now } });
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
