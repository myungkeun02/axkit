import type { Migration, SqlDatabase } from '../store/types.js';
import type { AuditEntry, AuditLog } from './types.js';
import { sanitize } from './sanitize.js';

export const AUDIT_MIGRATIONS: readonly Migration[] = [
  {
    id: 'core/002-audit',
    sql: `
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
`,
  },
];

function serializeDetail(detail: Record<string, unknown> | undefined): string {
  if (detail === undefined) return 'null';
  try {
    return JSON.stringify(sanitize(detail));
  } catch {
    return '"[unserializable]"';
  }
}

function parseDetail(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export class SqliteAuditLog implements AuditLog {
  constructor(private readonly sql: SqlDatabase) {}

  async append(entry: AuditEntry): Promise<void> {
    this.sql.run(
      'INSERT INTO audit (at, kind, subject, detail) VALUES (?, ?, ?, ?)',
      entry.at.toISOString(),
      entry.kind,
      entry.subject,
      serializeDetail(entry.detail),
    );
  }

  /** Newest first, for doctor and tests. */
  recent(limit: number): AuditEntry[] {
    const rows = this.sql.all(
      'SELECT at, kind, subject, detail FROM audit ORDER BY id DESC LIMIT ?',
      limit,
    );
    return rows.map((row) => {
      const detail = parseDetail(row.detail);
      return {
        at: new Date(String(row.at)),
        kind: String(row.kind),
        subject: String(row.subject),
        ...(detail !== undefined ? { detail } : {}),
      };
    });
  }

  /** Deletes entries older than `before`; returns how many rows were removed. */
  prune(before: Date): number {
    const iso = before.toISOString();
    const row = this.sql.get('SELECT COUNT(*) AS count FROM audit WHERE at < ?', iso);
    const count = typeof row?.count === 'number' ? row.count : 0;
    this.sql.run('DELETE FROM audit WHERE at < ?', iso);
    return count;
  }
}
