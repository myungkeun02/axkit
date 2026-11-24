import { randomUUID } from 'node:crypto';
import type { Migration, SqlDatabase } from '../store/types.js';

/**
 * What the assistant and its bots actually did, one readable line each: finished actions that changed something,
 * finished delegations and jobs. The calendar's "done" list and the bot pages read it. No message bodies, no secrets:
 * only the same one-line summary the owner saw on a card.
 */
export const WORK_LOG_MIGRATIONS: readonly Migration[] = [
  {
    id: 'core/008-work-log',
    sql: `CREATE TABLE IF NOT EXISTS work_log (id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, bot_id TEXT, bot_name TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS work_log_at ON work_log (at_ms);`,
  },
];

export interface WorkEntry {
  id: string;
  at: string;
  title: string;
  /** "action", "auto" (ran under a standing rule), "delegation", "job". */
  kind: string;
  bot?: { id: string; name: string };
  detail?: string;
}

export interface WorkLog {
  add(entry: { at: Date; title: string; kind: string; bot?: { id: string; name: string }; detail?: string }): Promise<void>;
  between(from: Date, to: Date, limit?: number): Promise<WorkEntry[]>;
}

const MAX_TITLE = 200;
const MAX_DETAIL = 500;

export class SqliteWorkLog implements WorkLog {
  constructor(private readonly sql: SqlDatabase) {}

  add(entry: { at: Date; title: string; kind: string; bot?: { id: string; name: string }; detail?: string }): Promise<void> {
    this.sql.run(
      'INSERT INTO work_log (id, at_ms, title, kind, bot_id, bot_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomUUID(),
      entry.at.getTime(),
      entry.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE),
      entry.kind,
      entry.bot?.id ?? null,
      entry.bot?.name ?? null,
      entry.detail?.slice(0, MAX_DETAIL) ?? null,
    );
    return Promise.resolve();
  }

  between(from: Date, to: Date, limit = 2000): Promise<WorkEntry[]> {
    const rows = this.sql.all(
      'SELECT * FROM work_log WHERE at_ms >= ? AND at_ms < ? ORDER BY at_ms LIMIT ?',
      from.getTime(),
      to.getTime(),
      limit,
    );
    return Promise.resolve(
      rows.map((row) => ({
        id: String(row.id),
        at: new Date(Number(row.at_ms)).toISOString(),
        title: String(row.title),
        kind: String(row.kind),
        ...(typeof row.bot_id === 'string' ? { bot: { id: row.bot_id, name: String(row.bot_name ?? row.bot_id) } } : {}),
        ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
      })),
    );
  }
}
