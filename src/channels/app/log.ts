import type { Clock } from '../../core/scheduler/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { AppEvent, AppEventDraft } from './protocol.js';

const LOG_KEY = 'log';
const MAX_EVENTS = 1000;

/** Keeps the newest MAX_EVENTS, plus older cards still waiting for an answer (and nothing else from before). */
export function trimLog(events: readonly AppEvent[], max = MAX_EVENTS): AppEvent[] {
  if (events.length <= max) return [...events];
  const cut = events.length - max;
  const closed = new Set(events.flatMap((event) => (event.type === 'card_closed' ? [event.cardId] : [])));
  const keptOld = events.slice(0, cut).filter((event) => event.type === 'card' && !closed.has(event.cardId));
  return [...keptOld, ...events.slice(cut)];
}

interface StoredLog {
  seq: number;
  events: AppEvent[];
}

type Listener = (event: AppEvent) => void;

/**
 * The single ordered history every app client syncs from. Kept in kv (bounded) so a phone that was offline over a
 * restart still gets what it missed. Writes are serialized so seq never repeats.
 */
export class AppEventLog {
  private state: StoredLog = { seq: 0, events: [] };
  private loaded: Promise<void> | undefined;
  private writing: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
  ) {}

  async append(draft: AppEventDraft): Promise<AppEvent> {
    await this.load();
    const next = this.writing.then(async () => {
      const event = { ...draft, seq: this.state.seq + 1, at: this.clock.now().toISOString() } as AppEvent;
      this.state = { seq: event.seq, events: trimLog([...this.state.events, event]) };
      await this.kv.set(LOG_KEY, this.state);
      for (const listener of this.listeners) listener(event);
      return event;
    });
    this.writing = next.catch(() => undefined);
    return await next;
  }

  async after(seq: number, limit: number): Promise<AppEvent[]> {
    await this.load();
    return this.state.events.filter((event) => event.seq > seq).slice(0, limit);
  }

  async lastSeq(): Promise<number> {
    await this.load();
    return this.state.seq;
  }

  /** Seq of the oldest event still kept (older ones were dropped); 0 when the log is empty. */
  async oldestSeq(): Promise<number> {
    await this.load();
    return this.state.events[0]?.seq ?? 0;
  }

  /** Cards still open in the log, e.g. after a restart lost their waiting promise. */
  async openCards(): Promise<string[]> {
    await this.load();
    const closed = new Set(this.state.events.flatMap((event) => (event.type === 'card_closed' ? [event.cardId] : [])));
    return this.state.events.flatMap((event) => (event.type === 'card' && !closed.has(event.cardId) ? [event.cardId] : []));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const stored = await this.kv.get<StoredLog>(LOG_KEY);
      if (stored !== undefined && Array.isArray(stored.events) && typeof stored.seq === 'number') this.state = stored;
    })();
    return this.loaded;
  }
}
