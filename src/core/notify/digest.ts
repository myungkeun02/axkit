import type { Notice } from '../contracts/notify.js';
import type { KeyValueStore } from '../store/types.js';

const KEY = 'notify.digest';
const MAX_ENTRIES = 200;
const MAX_STORED_TEXT = 300;
const MAX_LINE = 120;

export interface DigestEntry {
  kind: string;
  text: string;
}

/**
 * Notices over the daily budget, waiting for one evening message.
 * Only kind and text are kept: buttons from the morning would be stale by evening.
 */
export class DigestQueue {
  constructor(private readonly kv: KeyValueStore) {}

  async push(notice: Notice): Promise<void> {
    const entries = await this.all();
    entries.push({ kind: notice.kind, text: notice.text.slice(0, MAX_STORED_TEXT) });
    // The owner reads this once; dropping the oldest beats an unbounded store if a plugin runs wild.
    await this.kv.set(KEY, entries.slice(-MAX_ENTRIES));
  }

  async all(): Promise<DigestEntry[]> {
    return [...((await this.kv.get<DigestEntry[]>(KEY)) ?? [])];
  }

  async clear(): Promise<void> {
    await this.kv.delete(KEY);
  }
}

/** One message for the evening: a title, up to `maxLines` one-line entries, then "… +K". */
export function buildDigestMessage(
  title: (count: number) => string,
  entries: readonly DigestEntry[],
  maxLines = 15,
): string {
  const lines = entries.slice(0, maxLines).map((entry) => `- ${firstLine(entry.text)}`);
  const hidden = entries.length - maxLines;
  if (hidden > 0) lines.push(`… +${hidden}`);
  return [title(entries.length), ...lines].join('\n');
}

function firstLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
}
