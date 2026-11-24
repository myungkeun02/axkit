import type { MailQuery, MailReader, MailSummary } from '../../core/contracts/index.js';
import type { KeyValueStore } from '../../core/store/types.js';

export const CURSOR_KEY = 'triage:cursor';
const SEEN_CAP = 1_000;
/** Mail found but not yet handled (over the per-run cap, or its read or model call failed), kept across runs. */
export const BACKLOG_CAP = 500;
/** A mail that failed this many times is given up (marked seen) so one broken message cannot block the queue. */
export const BACKLOG_TRIES = 5;
const MAX_LOOKBACK_HOURS = 72;
/** Pages with new mail in one search; a flood beyond this is left for the next run (the cursor does not move past it). */
const MAX_PAGES = 10;
/** Pages of mail already handled are walked through without counting, up to this many in all. */
const MAX_TOTAL_PAGES = 60;

export interface BacklogEntry {
  id: string;
  tries: number;
}

export interface Cursor {
  /** Every match before this was found and is either seen or in the backlog; the next search starts a little before it. */
  at: string;
  seen: string[];
  backlog: BacklogEntry[];
}

export async function loadCursor(kv: KeyValueStore): Promise<Cursor | undefined> {
  const stored = await kv.get<unknown>(CURSOR_KEY);
  if (typeof stored !== 'object' || stored === null) return undefined;
  const record = stored as Record<string, unknown>;
  if (typeof record.at !== 'string' || !Array.isArray(record.seen)) return undefined;
  const backlog = Array.isArray(record.backlog)
    ? record.backlog.flatMap((entry: unknown): BacklogEntry[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const { id, tries } = entry as Record<string, unknown>;
        return typeof id === 'string' ? [{ id, tries: typeof tries === 'number' ? tries : 0 }] : [];
      })
    : [];
  return { at: record.at, seen: record.seen.filter((id): id is string => typeof id === 'string'), backlog };
}

export async function saveCursor(kv: KeyValueStore, cursor: Cursor): Promise<void> {
  const backlog = cursor.backlog.slice(-BACKLOG_CAP);
  await kv.set(CURSOR_KEY, { at: cursor.at, seen: cursor.seen.slice(-SEEN_CAP), backlog } satisfies Cursor);
}

export function lookbackHours(cursor: Cursor | undefined, now: Date): number {
  if (cursor === undefined) return 24;
  const since = Date.parse(cursor.at);
  if (!Number.isFinite(since)) return 24;
  // one extra hour so mail that arrived while the last run was searching is not missed (seen ids dedupe it)
  return Math.min(MAX_LOOKBACK_HOURS, Math.max(1, Math.ceil((now.getTime() - since) / 3_600_000) + 1));
}

/** Every match of the query, page by page (newest first); `complete` is false when the page cap cut it short. */
export async function searchAll(mail: MailReader, query: MailQuery, known: (id: string) => boolean = () => false): Promise<{ found: MailSummary[]; complete: boolean }> {
  if (mail.searchPage === undefined) {
    // a reader without pages gives one page; it is taken as all there is, as before
    return { found: await mail.search(query), complete: true };
  }
  const found: MailSummary[] = [];
  let token: string | undefined;
  let counted = 0;
  for (let page = 0; page < MAX_TOTAL_PAGES && counted < MAX_PAGES; page += 1) {
    const result = await mail.searchPage(query, token);
    found.push(...result.messages);
    // a page of mail already handled does not use up the cap, so older new mail behind it is still reached
    if (result.messages.some((message) => !known(message.id))) counted += 1;
    token = result.nextPageToken;
    if (token === undefined) return { found, complete: true };
  }
  return { found, complete: false };
}
