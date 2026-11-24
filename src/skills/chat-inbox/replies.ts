import type { Choice } from '../../core/conversation/types.js';
import { Contracts } from '../../core/contracts/index.js';
import { ymdOf } from '../../core/time/local-day.js';
import type { ChatInboxDeps } from './deps.js';
import { quoteText } from './snippet.js';
import type { PendingEntry } from './store.js';
import { roomKey } from './store.js';

export const REPLIES_JOB = 'chat-inbox.replies';

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const MAX_LINES = 5;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ageText(firstAt: string, now: Date, deps: ChatInboxDeps): string {
  const since = Date.parse(firstAt);
  const hours = Math.max(1, Math.floor((now.getTime() - since) / HOUR_MS));
  return deps.texts.ago(hours, Math.floor(hours / 24));
}

function partition(
  entries: readonly PendingEntry[],
  now: Date,
  olderThanMs: number,
): { kept: PendingEntry[]; due: PendingEntry[] } {
  const kept: PendingEntry[] = [];
  const due: PendingEntry[] = [];
  for (const entry of entries) {
    const since = Date.parse(entry.firstAt);
    if (!Number.isFinite(since)) continue;
    const age = now.getTime() - since;
    if (age > WEEK_MS) continue;
    kept.push(entry);
    if (age >= olderThanMs) due.push(entry);
  }
  due.sort((a, b) => a.firstAt.localeCompare(b.firstAt));
  return { kept, due };
}

function choicesFor(due: readonly PendingEntry[], deps: ChatInboxDeps): Choice[] {
  const choices: Choice[] = due.slice(0, MAX_LINES).map((entry) => ({
    id: `chat-inbox.done:${roomKey(entry.app, entry.room)}`,
    label: deps.texts.repliedChoice(entry.room),
  }));
  choices.push({ id: 'chat-inbox.mute:replies', label: deps.texts.muteRepliesLabel });
  return choices;
}

function linesFor(due: readonly PendingEntry[], deps: ChatInboxDeps, now: Date): string[] {
  const lines = [deps.texts.repliesTitle(due.length)];
  for (const entry of due.slice(0, MAX_LINES)) {
    lines.push(
      deps.texts.replyLine(
        entry.app,
        entry.room,
        ageText(entry.firstAt, now, deps),
        quoteText(entry.lastText, 60),
      ),
    );
  }
  return lines;
}

async function sendDigest(deps: ChatInboxDeps, now: Date): Promise<void> {
  const entries = deps.store.pendingEntries();
  if (entries.length === 0) return;

  const { kept, due } = partition(entries, now, deps.config.olderThanHours * HOUR_MS);
  if (kept.length !== entries.length) await deps.store.setPending(kept);
  if (due.length === 0) return;

  const notifier = deps.ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    deps.ctx.log.warn('chat-inbox: replies digest skipped without a notifier');
    return;
  }

  try {
    await notifier.notify({
      kind: 'chat.replies',
      dedupeKey: ymdOf(now, deps.ctx.assistant.timezone),
      text: linesFor(due, deps, now).join('\n'),
      choices: choicesFor(due, deps),
    });
  } catch (error) {
    deps.ctx.log.warn('chat-inbox: replies digest failed', { error: errorMessage(error) });
  }
}

/** Registers the daily digest of rooms whose latest preview is still unanswered. */
export function registerReplies(deps: ChatInboxDeps): void {
  deps.ctx.scheduler.add({
    name: REPLIES_JOB,
    schedule: { kind: 'daily', at: deps.config.repliesAt as `${number}:${number}` },
    run: (now) => sendDigest(deps, now),
  });
}
