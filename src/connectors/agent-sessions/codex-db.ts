import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionFs } from './fs.js';
import { listDir, regularFile } from './fs.js';
import { MAX_SESSIONS, isoFromEpoch, str } from './text.js';

/** One row of Codex's `threads` table, unmasked; only what the reader uses. */
export interface CodexThreadRow {
  id: string;
  rolloutPath?: string;
  startedAt?: string;
  updatedAt?: string;
  cwd?: string;
  title?: string;
  firstUserMessage?: string;
  gitBranch?: string;
  gitOrigin?: string;
}

const WANTED = [
  'id',
  'rollout_path',
  'created_at',
  'created_at_ms',
  'updated_at',
  'updated_at_ms',
  'cwd',
  'title',
  'first_user_message',
  'git_branch',
  'git_origin_url',
] as const;

/** The highest-numbered `state_<n>.sqlite` under `<home>/.codex`, when it is a plain file. */
export async function codexStatePath(fs: SessionFs, home: string): Promise<string | undefined> {
  const dir = join(home, '.codex');
  let best: { n: number; name: string } | undefined;
  for (const entry of await listDir(fs, dir)) {
    const match = /^state_(\d+)\.sqlite$/.exec(entry.name);
    if (match === null || !entry.isFile || entry.isSymbolicLink) continue;
    const n = Number(match[1]);
    if (best === undefined || n > best.n) best = { n, name: entry.name };
  }
  if (best === undefined) return undefined;
  const path = join(dir, best.name);
  return (await regularFile(fs, path)) !== undefined ? path : undefined;
}

function toRow(raw: Record<string, unknown>): CodexThreadRow | undefined {
  const id = str(raw.id);
  if (id === undefined) return undefined;
  const fields: Record<string, string | undefined> = {
    rolloutPath: str(raw.rollout_path),
    startedAt: isoFromEpoch(raw.created_at_ms, raw.created_at),
    updatedAt: isoFromEpoch(raw.updated_at_ms, raw.updated_at),
    cwd: str(raw.cwd),
    title: str(raw.title),
    firstUserMessage: str(raw.first_user_message),
    gitBranch: str(raw.git_branch),
    gitOrigin: str(raw.git_origin_url),
  };
  const row: CodexThreadRow = { id };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (row as unknown as Record<string, unknown>)[key] = value;
  }
  return row;
}

/**
 * Threads from Codex's state database, newest first. Opened read-only; a missing, locked or differently shaped
 * database is simply no rows. Columns absent in older versions are left out of the query.
 */
export async function readCodexThreads(fs: SessionFs, home: string): Promise<CodexThreadRow[]> {
  const path = await codexStatePath(fs, home);
  if (path === undefined) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const present = new Set(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map((col) => col.name),
    );
    if (!present.has('id')) return [];
    const columns = WANTED.filter((name) => present.has(name));
    const order = ['updated_at_ms', 'updated_at', 'created_at_ms', 'created_at'].find((name) => present.has(name));
    const sql =
      `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM threads` +
      (order !== undefined ? ` ORDER BY "${order}" DESC` : '') +
      ` LIMIT ${MAX_SESSIONS}`;
    const rows: CodexThreadRow[] = [];
    for (const raw of db.prepare(sql).all()) {
      const row = toRow(raw as Record<string, unknown>);
      if (row !== undefined) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed or never opened.
    }
  }
}
