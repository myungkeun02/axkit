/**
 * Local store (SQLite through node:sqlite). Plugins get a namespaced key-value view and may ship their own
 * migrations; raw SQL access stays inside core and connector repositories that need it.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Migration {
  /** "<plugin-id>/<NNN>-<name>", applied once in order. */
  id: string;
  sql: string;
}

/** Raw parameterized access for core repositories (ledger, audit); never exposed to plugins. */
export type SqlParam = string | number | null;

export interface SqlDatabase {
  exec(sql: string): void;
  run(sql: string, ...params: SqlParam[]): void;
  all(sql: string, ...params: SqlParam[]): Record<string, unknown>[];
  get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined;
}

export interface Store {
  migrate(migrations: readonly Migration[]): Promise<string[]>;
  kv(namespace: string): KeyValueStore;
  sql: SqlDatabase;
  close(): Promise<void>;
}
