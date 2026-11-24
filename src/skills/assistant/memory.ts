import type { ConversationRef } from '../../core/conversation/types.js';
import { threadOf } from '../../core/conversation/thread.js';
import type { LlmGateway } from '../../core/llm/types.js';
import type { Logger } from '../../core/log/types.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { maskSecrets } from './mask.js';
import type { ConversationMemory, MemoryTurn, StoredMemory } from './memory-shape.js';
import { NOTICE_TAG, SUMMARY_SYSTEM, emptyMemory, mergeMemory, parseMemory, sameTurn } from './memory-shape.js';
import { wrapData } from './render.js';
import { capLines, keepRefs } from './tool-refs.js';

export type { ConversationMemory, MemoryTurn } from './memory-shape.js';
export { maskSecrets };

export interface MemoryOptions {
  kv: KeyValueStore;
  llm: LlmGateway;
  clock: Clock;
  log: Logger;
  historyTurns: number;
}

/** What a finished turn adds besides the two lines. */
export interface TurnExtras {
  /** Compact references from this turn's tool outputs. */
  refs?: readonly string[];
}

const MAX_SUMMARY_CHARS = 1_500;
const REF_TURNS = 3;
const NOTICES_KEPT = 3;
const NOTICE_CHARS = 300;
/** Summaries keep failing: past this many times the limit, the oldest turns go anyway. */
const HARD_CAP_FACTOR = 4;
/** A compaction whose summary went stale this many times in a row waits for the next turn. */
const COMPACT_ATTEMPTS = 3;

/**
 * Per-conversation history: recent turns kept verbatim, older turns folded into a short summary once a summary
 * succeeds. The owner's own chats (app, Discord DM) share one thread. Every write re-reads under a per-key lock, so
 * a summary that took a while never overwrites what was appended meanwhile.
 */
export class MemoryStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: MemoryOptions) {}

  key(ref: ConversationRef): string {
    const thread = threadOf(ref);
    return thread !== undefined ? `conv:thread:${thread}` : this.channelKey(ref);
  }

  private channelKey(ref: ConversationRef): string {
    return `conv:${ref.channelId}:${ref.address}`;
  }

  private locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).then(work);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  /** Reads the stored memory; a thread folds the old per-channel memory of this channel in, once. Lock held. */
  private async read(ref: ConversationRef): Promise<StoredMemory> {
    const key = this.key(ref);
    const stored: StoredMemory = parseMemory(await this.opts.kv.get<unknown>(key)) ?? emptyMemory();
    const old = this.channelKey(ref);
    if (key === old || stored.migrated?.includes(old) === true) return stored;
    const previous = parseMemory(await this.opts.kv.get<unknown>(old));
    const merged: StoredMemory = {
      ...(previous !== undefined ? { ...mergeMemory(stored, previous), rev: (stored.rev ?? 0) + 1 } : stored),
      migrated: [...(stored.migrated ?? []), old],
    };
    await this.opts.kv.set(key, merged);
    if (previous !== undefined) await this.opts.kv.delete(old);
    return merged;
  }

  load(ref: ConversationRef): Promise<ConversationMemory> {
    return this.locked(this.key(ref), async () => {
      const stored = await this.read(ref);
      return { summary: stored.summary, turns: stored.turns, refs: stored.refs };
    });
  }

  private update(ref: ConversationRef, change: (memory: StoredMemory) => StoredMemory): Promise<void> {
    return this.locked(this.key(ref), async () => {
      await this.opts.kv.set(this.key(ref), change(await this.read(ref)));
    });
  }

  /** Appends both sides of a turn. Folding old turns into the summary is `compact`, run after delivery. */
  append(ref: ConversationRef, ownerText: string, replyText: string, extras: TurnExtras = {}): Promise<void> {
    const owner = this.turn('owner', ownerText);
    const reply = this.turn('assistant', replyText);
    const refs = extras.refs !== undefined ? { at: reply.at, lines: capLines(extras.refs) } : undefined;
    return this.update(ref, (memory) => ({
      ...memory,
      turns: [...memory.turns, owner, reply],
      refs: keepRefs(memory.refs, refs, REF_TURNS),
    }));
  }

  /** A notice the owner got outside a reply, as an assistant line; only the last few are kept. */
  notice(ref: ConversationRef, text: string): Promise<void> {
    const line = this.turn('assistant', `${NOTICE_TAG} ${text.replace(/\s+/g, ' ').trim().slice(0, NOTICE_CHARS)}`);
    return this.update(ref, (memory) => {
      const turns = [...memory.turns, line];
      const notices = turns.filter((turn) => turn.text.startsWith(NOTICE_TAG));
      const drop = new Set(notices.slice(0, Math.max(0, notices.length - NOTICES_KEPT)));
      return { ...memory, turns: turns.filter((turn) => !drop.has(turn)) };
    });
  }

  /**
   * Folds the oldest half into the summary when the history grew past the limit. The older turns stay until a
   * summary actually comes back; the result is merged into what is stored by then. A summary built from an older
   * revision (a migration or another compaction changed it meanwhile) is thrown away and built again from the new one.
   */
  async compact(ref: ConversationRef): Promise<void> {
    const limit = this.opts.historyTurns * 2;
    for (let attempt = 0; attempt < COMPACT_ATTEMPTS; attempt += 1) {
      const snapshot = await this.locked(this.key(ref), () => this.read(ref));
      if (snapshot.turns.length <= limit) return;
      const folded = snapshot.turns.slice(0, Math.ceil(snapshot.turns.length / 2));
      const summary = await this.summarize(snapshot.summary, folded);
      const applied = await this.locked(this.key(ref), async () => {
        const memory = await this.read(ref);
        if (summary !== undefined && (memory.rev ?? 0) !== (snapshot.rev ?? 0)) return false;
        await this.opts.kv.set(this.key(ref), this.folded(memory, summary, folded, limit));
        return true;
      });
      if (applied) return;
      this.opts.log.debug('conversation summary changed while compacting; building it again');
    }
  }

  private folded(memory: StoredMemory, summary: string | undefined, folded: readonly MemoryTurn[], limit: number): StoredMemory {
    if (summary !== undefined) {
      return { ...memory, summary, rev: (memory.rev ?? 0) + 1, turns: memory.turns.filter((turn) => !folded.some((gone) => sameTurn(gone, turn))) };
    }
    const cap = limit * HARD_CAP_FACTOR;
    if (memory.turns.length <= cap) return memory;
    this.opts.log.warn('conversation summaries keep failing; dropping the oldest turns', { kept: cap });
    return { ...memory, turns: memory.turns.slice(-cap) };
  }

  private turn(role: MemoryTurn['role'], text: string): MemoryTurn {
    return { role, text: maskSecrets(text), at: this.opts.clock.now().toISOString() };
  }

  /** The merged summary, or undefined when the model failed or returned nothing. */
  private async summarize(previous: string, turns: readonly MemoryTurn[]): Promise<string | undefined> {
    const conversation = turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n');
    const body = previous.length > 0 ? `Previous summary: ${previous}\n\nNew turns:\n${conversation}` : conversation;
    try {
      const response = await this.opts.llm.complete({
        purpose: 'assistant.summary',
        tier: 'fast',
        sensitivity: 'sensitive',
        maxOutputTokens: 400,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: wrapData('conversation', body) },
        ],
      });
      const summary = maskSecrets(response.text).trim();
      if (summary.length > 0) return summary.slice(0, MAX_SUMMARY_CHARS);
      this.opts.log.warn('conversation summary came back empty; older turns kept');
      return undefined;
    } catch (error) {
      this.opts.log.warn('conversation summary failed; older turns kept', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
