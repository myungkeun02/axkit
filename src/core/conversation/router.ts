import type { EventBus, Unsubscribe } from '../events/types.js';
import type { AwaitOwner, CompletedTool, InProgressTurn, IncomingMessage, MessageHandler, Replier, TurnContext } from './types.js';
import type { Logger } from '../log/types.js';
import type { Claim, PendingMessages, Recovered } from './pending.js';
import { isCancelPhrase } from './cancel.js';
import { DeliveryRetry, collectingReplier } from './delivery.js';
import { conversationKey } from './thread.js';
import type { QueueSlot } from './turn-queue.js';
import { KeyedQueue } from './turn-queue.js';

interface RouterOptions {
  handlers: () => readonly MessageHandler[];
  replier: () => Replier | undefined;
  log: Logger;
  failureText: string;
  /** Owner messages in flight, so a restart answers what it dropped. */
  pending?: PendingMessages;
  /** Put in front of a message answered after a restart ("(늦게 답해요) "). */
  lateNote?: string;
  /** Delays between delivery retries; tests shorten them. */
  retryDelaysMs?: readonly number[];
}

const RECENT_IDS = 500;
/** Effects that changed something outside the conversation: a replay must not run them again blindly. */
const LASTING = new Set(['write', 'send', 'pay', 'delete', 'system']);
const NEW_TURN: Claim = { state: 'run', tools: [] };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastingOnly(tools: readonly CompletedTool[]): readonly CompletedTool[] | undefined {
  return tools.some((tool) => tool.effects.some((effect) => LASTING.has(effect))) ? tools : undefined;
}

/** A turn waiting for the owner's answer, with its slot given up. */
interface Suspended {
  id: string;
  cancel: AbortController;
  what?: string;
}

export class MessageRouter {
  private bus: EventBus | undefined;
  /** One message is answered once, even when a restart's recovery and a channel's catch-up both bring it back. */
  private readonly recent = new Set<string>();
  /** Turns of one conversation run one after another, from loading its memory to delivering the reply. */
  private readonly queue = new KeyedQueue();
  /** Per conversation: owner messages that arrived and are not answered yet, oldest first. */
  private readonly waiting = new Map<string, InProgressTurn[]>();
  /** Per conversation: turns waiting for the owner (a card), newest last. */
  private readonly suspended = new Map<string, Suspended[]>();
  private readonly retry: DeliveryRetry | undefined;
  private closing = false;

  constructor(private readonly opts: RouterOptions) {
    this.retry =
      opts.pending === undefined
        ? undefined
        : new DeliveryRetry({ pending: opts.pending, replier: opts.replier, log: opts.log, ...(opts.retryDelaysMs !== undefined ? { delaysMs: opts.retryDelaysMs } : {}) });
  }

  attach(bus: EventBus): Unsubscribe {
    this.bus = bus;
    return bus.on('message.received', async (message) => {
      await this.dispatch(message);
    });
  }

  /** The "typing" hint never holds up or breaks the reply. */
  private activity(message: IncomingMessage, state: 'thinking' | 'idle'): void {
    void this.bus?.emit('assistant.activity', { conversation: message.conversation, state }).catch(() => undefined);
  }

  /**
   * Resolves when this message's turn is over. Everything before the queue is synchronous, so arrival order holds.
   * `claimed` is set by recovery, which already claimed the pending entry; otherwise the arrival claims it here.
   */
  private dispatch(message: IncomingMessage, claimed?: Claim): Promise<void> {
    if (!message.fromOwner) {
      this.opts.log.debug('ignoring non-owner message', { id: message.id });
      return Promise.resolve();
    }
    if (this.closing) {
      // shutting down: kept for the next start instead of started now
      this.opts.log.info('message arrived while stopping; answering after the restart', { id: message.id });
      return this.opts.pending?.begin(message).catch(() => undefined) ?? Promise.resolve();
    }
    const replier = this.opts.replier();
    if (replier === undefined) {
      this.opts.log.warn('no replier available', { id: message.id });
      return Promise.resolve();
    }

    // a replay recovery already claimed is never a duplicate; the claim itself keeps one message to one turn
    if (claimed === undefined && this.recent.has(message.id)) {
      this.opts.log.debug('message already handled', { id: message.id });
      return Promise.resolve();
    }
    this.recent.add(message.id);
    if (this.recent.size > RECENT_IDS) this.recent.delete(this.recent.values().next().value ?? '');

    const handlers = [...this.opts.handlers()].sort((a, b) => b.priority - a.priority);
    if (handlers.length === 0) {
      this.opts.log.debug('no message handlers registered', { id: message.id });
      return Promise.resolve();
    }

    const key = conversationKey(message.conversation);
    // "취소해" while a card waits answers that card instead of starting a turn of its own
    const held = this.suspended.get(key)?.at(-1);
    if (claimed === undefined && held !== undefined && isCancelPhrase(message.text)) {
      this.opts.log.info('owner cancelled a waiting confirmation in chat', { id: message.id, turn: held.id });
      held.cancel.abort();
      return Promise.resolve();
    }

    // claimed the moment it arrives, even while an earlier turn of this conversation still runs
    const claim = claimed !== undefined ? Promise.resolve(claimed) : (this.opts.pending?.claim(message).catch(() => NEW_TURN) ?? Promise.resolve(NEW_TURN));
    this.waiting.set(key, [...(this.waiting.get(key) ?? []), { id: message.id, text: message.text, at: message.receivedAt }]);
    const forget = (): void => {
      const left = (this.waiting.get(key) ?? []).filter((item) => item.id !== message.id);
      if (left.length > 0) this.waiting.set(key, left);
      else this.waiting.delete(key);
    };
    return this.queue.run(key, async (slot) => {
      const found = await claim;
      try {
        if (found.state === 'taken') {
          this.opts.log.debug('message already taken by another arrival', { id: message.id });
          return;
        }
        if (found.state === 'deliver') {
          // the turn finished before a restart; only its reply is still owed
          if ((await this.retry?.attempt(message.id)) === false) this.retry?.schedule(message.id);
          return;
        }
        await this.turn(message, replier, handlers, lastingOnly(found.tools), () => this.waiting.get(key) ?? [], this.owner(key, message.id, slot));
      } finally {
        forget();
      }
    });
  }

  /** The turn's way to wait for the owner with its slot given up; a chat cancellation aborts the wait's signal. */
  private owner(key: string, id: string, slot: QueueSlot): AwaitOwner {
    return async <T>(wait: (signal: AbortSignal) => Promise<T>, what?: string): Promise<T> => {
      const entry: Suspended = { id, cancel: new AbortController(), ...(what !== undefined ? { what } : {}) };
      this.suspended.set(key, [...(this.suspended.get(key) ?? []), entry]);
      return await slot.suspend(async () => {
        try {
          return await wait(entry.cancel.signal);
        } finally {
          const left = (this.suspended.get(key) ?? []).filter((item) => item !== entry);
          if (left.length > 0) this.suspended.set(key, left);
          else this.suspended.delete(key);
        }
      });
    };
  }

  private async turn(
    message: IncomingMessage,
    channel: Replier,
    handlers: readonly MessageHandler[],
    resumed: readonly CompletedTool[] | undefined,
    inProgress: () => readonly InProgressTurn[],
    awaitOwner: AwaitOwner,
  ): Promise<void> {
    const pending = this.opts.pending;
    const { replier, failed } = collectingReplier(channel, this.opts.log);
    const later: (() => Promise<void>)[] = [];
    const context: TurnContext = {
      inProgress,
      awaitOwner,
      awaiting: () => (this.suspended.get(conversationKey(message.conversation)) ?? []).flatMap((item) => (item.what !== undefined ? [item.what] : [])),
      afterTurn: (work) => void later.push(work),
      ...(pending !== undefined ? { onToolDone: (tool: CompletedTool) => void pending.toolDone(message.id, tool).catch(() => undefined) } : {}),
      ...(resumed !== undefined ? { resumed } : {}),
    };
    this.activity(message, 'thinking');
    try {
      await this.tryHandlers(message, replier, handlers, context);
    } finally {
      // finished only once the reply got through; otherwise kept and delivered again later
      if (failed.length === 0) await pending?.finish(message.id).catch(() => undefined);
      else {
        await pending?.undelivered(message.id, failed).catch(() => undefined);
        this.retry?.schedule(message.id);
      }
      this.activity(message, 'idle');
      // after the reply is settled for good, and without holding the conversation
      for (const work of later) void work().catch((error: unknown) => this.opts.log.warn('after-turn work failed', { error: reasonOf(error) }));
    }
  }

  /**
   * After a restart: owner messages whose turn never finished are handled again, once, oldest first and one after
   * another, with a short note that the answer is late. One that already failed twice is let go. A turn that already
   * ran tools with effects is told what ran instead of running it again; a finished turn only has its reply delivered.
   * An entry a channel's catch-up claimed first is left to it.
   */
  async recover(now: Date): Promise<number> {
    const pending = this.opts.pending;
    if (pending === undefined) return 0;
    const due = await pending.takeForRecovery(now).catch(() => [] as Recovered[]);
    for (const item of due) this.recent.add(item.message.id);
    const deliveries = due.filter((item) => item.outbox.length > 0);
    const replays = due.filter((item) => item.outbox.length === 0);
    for (const item of deliveries) {
      void this.retry?.attempt(item.message.id).then((done) => {
        if (!done) this.retry?.schedule(item.message.id);
      });
    }
    void (async () => {
      for (const { message, tools } of replays) {
        this.opts.log.info('answering a message the restart dropped', { id: message.id });
        const late = this.opts.lateNote === undefined ? message : { ...message, text: `${this.opts.lateNote}${message.text}` };
        await this.dispatch(late, { state: 'run', tools }).catch(() => undefined);
      }
    })();
    return due.length;
  }

  /**
   * Shutdown: no new turn starts (a message arriving now is kept for the next start), and the turns already running
   * get up to `timeoutMs` to finish and deliver. True when they all did.
   */
  async close(timeoutMs: number): Promise<boolean> {
    this.closing = true;
    const settled = await this.queue.idle(timeoutMs);
    this.retry?.stop();
    if (!settled) this.opts.log.warn('stopping with a turn still running; it is answered after the restart');
    return settled;
  }

  private async tryHandlers(message: IncomingMessage, replier: Replier, handlers: readonly MessageHandler[], context: TurnContext): Promise<void> {
    for (const handler of handlers) {
      try {
        const result = await handler.handle(message, replier, context);
        if (result === 'handled') return;
      } catch (error) {
        this.opts.log.error('message handler failed', { handler: handler.id, error: reasonOf(error) });
        await replier.reply(message.conversation, { text: this.opts.failureText });
        return;
      }
    }
    this.opts.log.debug('no handler handled the message', { id: message.id });
  }
}
