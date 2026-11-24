import type { KeyValueStore } from '../store/types.js';
import type { CompletedTool, ConversationRef, IncomingMessage, OutgoingMessage } from './types.js';

const KEY = 'pending';
const MAX_PENDING = 50;
const MAX_TOOLS = 20;
/** Older than this when the server comes back: too late to answer as if nothing happened. */
export const RECOVER_WITHIN_MS = 12 * 60 * 60 * 1000;

/** A reply the turn produced that no channel took yet. */
export interface Undelivered {
  to: ConversationRef;
  message: OutgoingMessage;
}

interface Stored {
  id: string;
  conversation: IncomingMessage['conversation'];
  authorId: string;
  text: string;
  receivedAt: string;
  attempts: number;
  /** Tools that finished during the turn, in order. */
  tools?: CompletedTool[];
  /** Set when the turn finished but delivering its reply failed. */
  outbox?: Undelivered[];
}

export interface Recovered {
  message: IncomingMessage;
  attempts: number;
  tools: readonly CompletedTool[];
  /** Non-empty: the turn is done, only its reply still has to be delivered. */
  outbox: readonly Undelivered[];
}

/**
 * What a message's arrival found in the pending list, decided in one step so a restart's recovery and a channel's
 * catch-up never both start it: `run` starts a turn (with the tools an earlier run already finished), `deliver` only
 * sends the stored reply, `taken` means this run already handles it or it was let go.
 */
export type Claim = { state: 'run'; tools: readonly CompletedTool[] } | { state: 'deliver' } | { state: 'taken' };

function due(item: Stored, now: Date): boolean {
  if (now.getTime() - Date.parse(item.receivedAt) > RECOVER_WITHIN_MS) return false;
  return (item.outbox?.length ?? 0) > 0 || item.attempts < 2;
}

function entry(message: IncomingMessage, attempts: number, previous?: Stored): Stored {
  return {
    id: message.id,
    conversation: message.conversation,
    authorId: message.authorId,
    text: message.text,
    receivedAt: message.receivedAt.toISOString(),
    attempts,
    ...(previous?.tools !== undefined ? { tools: previous.tools } : {}),
    ...(previous?.outbox !== undefined ? { outbox: previous.outbox } : {}),
  };
}

/**
 * Owner messages whose turn has not finished, or whose reply was not delivered. A restart or crash in the middle of a
 * turn leaves them here; the next start answers each once (with a note that it is late), and a message that failed
 * twice is let go. Every change runs after the previous one, so two turns never overwrite each other's entry.
 */
export class PendingMessages {
  private chain: Promise<unknown> = Promise.resolve();
  /** Entries this run already started or delivers; another arrival of the same message is a duplicate. */
  private readonly claimed = new Set<string>();

  constructor(private readonly kv: KeyValueStore) {}

  private async list(): Promise<Stored[]> {
    const value = await this.kv.get<unknown>(KEY);
    return Array.isArray(value) ? (value as Stored[]).filter((item) => typeof item?.id === 'string' && typeof item.text === 'string') : [];
  }

  /** Runs `change` on the stored list after every earlier change; a returned list is saved. */
  private mutate<T>(change: (list: Stored[]) => { list?: Stored[]; result: T }): Promise<T> {
    const next = this.chain.then(async () => {
      const outcome = change(await this.list());
      if (outcome.list !== undefined) await this.kv.set(KEY, outcome.list.slice(-MAX_PENDING));
      return outcome.result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Records a message for the next start without claiming it (shutting down); what an earlier run left is kept. */
  begin(message: IncomingMessage): Promise<void> {
    return this.mutate((list) => {
      const previous = list.find((item) => item.id === message.id);
      const rest = list.filter((item) => item.id !== message.id);
      rest.push(entry(message, (previous?.attempts ?? 0) + 1, previous));
      return { list: rest, result: undefined };
    });
  }

  /**
   * A message arrived (typed now, or brought back by a channel's catch-up): claims its entry atomically, keeping the
   * phase an earlier run reached. A finished turn whose reply waits is only delivered; a started turn continues with
   * its finished tools; one that already broke a turn twice is let go.
   */
  claim(message: IncomingMessage): Promise<Claim> {
    return this.mutate<Claim>((list) => {
      if (this.claimed.has(message.id)) return { result: { state: 'taken' } };
      const previous = list.find((item) => item.id === message.id);
      if (previous !== undefined && (previous.outbox?.length ?? 0) > 0) {
        this.claimed.add(message.id);
        return { result: { state: 'deliver' } };
      }
      const rest = list.filter((item) => item.id !== message.id);
      if (previous !== undefined && previous.attempts >= 2) return { list: rest, result: { state: 'taken' } };
      this.claimed.add(message.id);
      rest.push(entry(message, (previous?.attempts ?? 0) + 1, previous));
      return { list: rest, result: { state: 'run', tools: previous?.tools ?? [] } };
    });
  }

  /** A tool of this turn finished; kept so a restart knows it already ran. */
  toolDone(id: string, tool: CompletedTool): Promise<void> {
    return this.mutate((list) => {
      const item = list.find((stored) => stored.id === id);
      if (item === undefined) return { result: undefined };
      // the arguments come along: after a restart the same action is refused, not run twice
      item.tools = [...(item.tools ?? []), { name: tool.name, effects: [...tool.effects], message: tool.message.slice(0, 200), ...(tool.args !== undefined ? { args: tool.args.slice(0, 2000) } : {}) }].slice(-MAX_TOOLS);
      return { list, result: undefined };
    });
  }

  /** The turn is over but its reply is not delivered: kept, with the reply, until a retry gets it through. */
  undelivered(id: string, outbox: readonly Undelivered[]): Promise<void> {
    return this.mutate((list) => {
      const item = list.find((stored) => stored.id === id);
      if (item === undefined) return { result: undefined };
      item.outbox = [...outbox];
      return { list, result: undefined };
    });
  }

  /** What still waits for delivery for this message. */
  outbox(id: string): Promise<Undelivered[]> {
    return this.mutate((list) => ({ result: list.find((stored) => stored.id === id)?.outbox ?? [] }));
  }

  finish(id: string): Promise<void> {
    return this.mutate((list) => {
      this.claimed.delete(id);
      return list.some((item) => item.id === id) ? { list: list.filter((item) => item.id !== id), result: undefined } : { result: undefined };
    });
  }

  /**
   * What to answer or deliver again after a restart, oldest first; the rest is dropped. What it returns is claimed
   * (a replay counts as another attempt), and an entry a catch-up already claimed is left to it.
   */
  takeForRecovery(now: Date): Promise<Recovered[]> {
    return this.mutate((list) => {
      const kept = list.filter((item) => due(item, now)).sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
      const mine = kept.filter((item) => !this.claimed.has(item.id));
      for (const item of mine) {
        this.claimed.add(item.id);
        if ((item.outbox?.length ?? 0) === 0) item.attempts += 1;
      }
      return {
        list: kept,
        result: mine.map((item) => ({
          attempts: item.attempts,
          tools: item.tools ?? [],
          outbox: item.outbox ?? [],
          message: { id: item.id, conversation: item.conversation, authorId: item.authorId, fromOwner: true, text: item.text, receivedAt: new Date(item.receivedAt) },
        })),
      };
    });
  }
}
