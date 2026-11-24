import type { Effect } from '../policy/types.js';
import type { Migration, SqlDatabase } from '../store/types.js';

/**
 * Global stop for everything that leaves this Mac in the owner's name: any tool with a send, pay or delete effect.
 * Reading and thinking go on. One row in SQLite; the executor checks it right before asking or acting, so a new tool
 * cannot skip it. Fail closed: an unreadable flag counts as stopped. Ported from AX `guard/kill.ts`.
 */
export const OUTWARD_EFFECTS: readonly Effect[] = ['send', 'pay', 'delete', 'system'];

export const KILL_MIGRATIONS: readonly Migration[] = [
  {
    id: 'core/006-kill-switch',
    sql: `CREATE TABLE IF NOT EXISTS kill_switch (id INTEGER PRIMARY KEY CHECK (id = 1), stopped INTEGER NOT NULL, reason TEXT, by_id TEXT NOT NULL, changed_ms INTEGER NOT NULL);`,
  },
];

export interface KillState {
  stopped: boolean;
  reason?: string;
  by?: string;
  changedAt?: string;
}

export interface KillSwitch {
  state(): Promise<KillState>;
  stop(reason: string, by: string): Promise<KillState>;
  resume(by: string): Promise<KillState>;
}

export function isOutward(effects: readonly Effect[]): boolean {
  return effects.some((effect) => OUTWARD_EFFECTS.includes(effect));
}

export class SqliteKillSwitch implements KillSwitch {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly now: () => Date,
  ) {}

  state(): Promise<KillState> {
    try {
      const row = this.sql.get('SELECT stopped, reason, by_id, changed_ms FROM kill_switch WHERE id = 1');
      if (row === undefined) return Promise.resolve({ stopped: false });
      return Promise.resolve({
        stopped: Number(row.stopped) === 1,
        ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
        by: String(row.by_id),
        changedAt: new Date(Number(row.changed_ms)).toISOString(),
      });
    } catch {
      return Promise.resolve({ stopped: true, reason: 'could not read the stop switch' });
    }
  }

  stop(reason: string, by: string): Promise<KillState> {
    const why = reason.trim().slice(0, 300) || 'no reason given';
    this.write(1, why, by);
    return this.state();
  }

  resume(by: string): Promise<KillState> {
    this.write(0, null, by);
    return this.state();
  }

  private write(stopped: 0 | 1, reason: string | null, by: string): void {
    this.sql.run(
      `INSERT INTO kill_switch (id, stopped, reason, by_id, changed_ms) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET stopped = excluded.stopped, reason = excluded.reason, by_id = excluded.by_id, changed_ms = excluded.changed_ms`,
      stopped,
      reason,
      by,
      this.now().getTime(),
    );
  }
}
