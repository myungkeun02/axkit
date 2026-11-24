import type { EventBus, EventHandler, EventMap, EventName, Unsubscribe } from './types.js';
import type { Logger } from '../log/types.js';

type AnyHandler = (payload: unknown) => void | Promise<void>;
type HandlerSet = Set<AnyHandler>;

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<EventName, HandlerSet>();

  constructor(private readonly log: Logger) {}

  on<K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe {
    let set = this.handlers.get(name);
    if (set === undefined) {
      set = new Set<AnyHandler>();
      this.handlers.set(name, set);
    }
    const stored: AnyHandler = (payload) => handler(payload as EventMap[K]);
    set.add(stored);
    return () => {
      set.delete(stored);
    };
  }

  async emit<K extends EventName>(name: K, payload: EventMap[K]): Promise<void> {
    const set = this.handlers.get(name);
    if (set === undefined || set.size === 0) return;
    const results = await Promise.allSettled([...set].map(async (handler) => await handler(payload)));
    for (const result of results) {
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.log.error('event handler failed', { event: name, error: reason });
      }
    }
  }
}
