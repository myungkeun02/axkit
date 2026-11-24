import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { KeyValueStore, Migration, SqlDatabase, SqlParam, Store } from './types.js';

const MEMORY_PATH = ':memory:';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  ns TEXT NOT NULL,
  "key" TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, "key")
);
`;

class SqliteKeyValueStore implements KeyValueStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly namespace: string,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT value FROM kv WHERE ns = ? AND "key" = ?').get(this.namespace, key);
    if (row === undefined) return undefined;
    const raw = row.value;
    if (typeof raw !== 'string') return undefined;
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value) ?? 'null';
    this.db
      .prepare(
        `INSERT INTO kv (ns, "key", value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (ns, "key") DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(this.namespace, key, serialized, new Date().toISOString());
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE ns = ? AND "key" = ?').run(this.namespace, key);
  }
}

function sqlDatabase(db: DatabaseSync): SqlDatabase {
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, ...params: SqlParam[]): void {
      db.prepare(sql).run(...params);
    },
    all(sql: string, ...params: SqlParam[]): Record<string, unknown>[] {
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    },
    get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined {
      return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    },
  };
}

export function openSqliteStore(path: string): Store {
  const memory = path === MEMORY_PATH;
  if (!memory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (!memory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  return {
    async migrate(migrations: readonly Migration[]): Promise<string[]> {
      const known = new Set(
        db.prepare('SELECT id FROM _migrations').all().map((row) => String(row.id)),
      );
      const applied: string[] = [];
      for (const migration of migrations) {
        if (known.has(migration.id)) continue;
        db.exec('BEGIN');
        try {
          db.exec(migration.sql);
          db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(
            migration.id,
            new Date().toISOString(),
          );
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        applied.push(migration.id);
      }
      return applied;
    },
    kv(namespace: string): KeyValueStore {
      return new SqliteKeyValueStore(db, namespace);
    },
    sql: sqlDatabase(db),
    async close(): Promise<void> {
      db.close();
    },
  };
}
