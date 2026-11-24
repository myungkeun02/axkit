import { createHash } from 'node:crypto';
import type { ChatApp, ChatPreview } from '../../core/contracts/index.js';
import type { KeyValueStore } from '../../core/store/types.js';

/** One line read from a screen; the tracker decides whether anyone should hear about it. */
export interface PreviewRow {
  room: string;
  text: string;
  unread: number | null;
  direct?: boolean;
}

interface SeenEntry {
  hash: string;
  unread: number | null;
}

type SeenMap = Record<string, SeenEntry>;

const SEEN_KEY = 'seen';
const MAX_ROOMS = 300;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function refOf(app: ChatApp, row: PreviewRow): string {
  const unread = row.unread !== null && row.unread > 0;
  return digest(`${app}\u0000${row.room}\u0000${row.text}\u0000${unread}`);
}

function positive(value: number | null): boolean {
  return value !== null && value > 0;
}

/** Emits one preview per room whose latest line or unread count changed since the previous poll. */
export class PreviewTracker {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly app: ChatApp,
  ) {}

  async diff(rows: readonly PreviewRow[], now: Date): Promise<ChatPreview[]> {
    const stored = await this.kv.get<SeenMap>(SEEN_KEY);
    let next: SeenMap = { ...(stored ?? {}) };
    const previews: ChatPreview[] = [];

    for (const row of rows) {
      const hash = digest(row.text);
      const previous = next[row.room];
      const changed = previous === undefined || previous.hash !== hash;
      const becameRead = previous !== undefined && positive(previous.unread) && row.unread === 0;
      const worthTelling = (changed && (row.unread === null || row.unread > 0)) || becameRead;
      const textUsable = row.text !== '' || positive(row.unread);

      if (stored !== undefined && worthTelling && textUsable) {
        previews.push({
          app: this.app,
          room: row.room,
          text: row.text,
          unread: row.unread,
          ...(row.direct !== undefined ? { direct: row.direct } : {}),
          at: now,
          ref: refOf(this.app, row),
        });
      }
      next[row.room] = { hash, unread: row.unread };
    }

    const keys = Object.keys(next);
    if (keys.length > MAX_ROOMS) {
      const kept: SeenMap = {};
      for (const key of keys.slice(keys.length - MAX_ROOMS)) {
        const entry = next[key];
        if (entry !== undefined) kept[key] = entry;
      }
      next = kept;
    }
    await this.kv.set(SEEN_KEY, next);
    return previews;
  }
}
