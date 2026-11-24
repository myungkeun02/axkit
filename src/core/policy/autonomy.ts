import { randomUUID } from 'node:crypto';
import type { Migration, SqlDatabase } from '../store/types.js';

/**
 * Standing rules the owner made by ticking "from now on, just do it" on a card. A rule covers one tool and one scope
 * key the tool (or the executor's default) defined; anything outside it gets a card again. The global stop switch is
 * checked before any rule, and pay/delete never get the default scope: only a tool that states its own bounds
 * (an amount cap, a merchant) can offer them. A rule can also come from saying yes when offered after many clean
 * approvals (origin "promoted", see promoter.ts); a paused rule is kept but no longer used.
 */
export const AUTONOMY_MIGRATIONS: readonly Migration[] = [
  {
    id: 'core/007-autonomy',
    sql: `CREATE TABLE IF NOT EXISTS autonomy_rules (id TEXT PRIMARY KEY, tool TEXT NOT NULL, scope TEXT NOT NULL, label TEXT NOT NULL, detail TEXT, created_ms INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, last_ms INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS autonomy_rules_scope ON autonomy_rules (tool, scope);`,
  },
  {
    id: 'core/010-autonomy-origin',
    sql: `ALTER TABLE autonomy_rules ADD COLUMN origin TEXT NOT NULL DEFAULT 'card';
ALTER TABLE autonomy_rules ADD COLUMN paused_ms INTEGER;`,
  },
];

/** card = the owner ticked "from now on" on a card; promoted = the owner said yes when offered after many approvals. */
export type AutonomyOrigin = 'card' | 'promoted';

export interface AutonomyRule {
  id: string;
  tool: string;
  /** The scope key; internal, never shown. */
  scope: string;
  label: string;
  detail?: string;
  since: string;
  uses: number;
  origin: AutonomyOrigin;
  /** ISO 8601, set while the rule is paused (cards come back until the owner turns it on again). */
  paused?: string;
}

export interface AutonomyScope {
  /** Stable key: the same key means "the same kind of action" for this tool. */
  key: string;
  label: string;
  detail?: string;
  /**
   * For `send` scopes: who receives it (an address, a room). A scope that sends is offered for promotion only when
   * the recipient is named here (or the scope is the exact-repeat default) and has been sent to a few times before.
   */
  recipient?: string;
}

export interface AutonomyRules {
  /** The rule for this scope, paused ones included (the executor skips a paused rule). */
  find(tool: string, scope: string): Promise<AutonomyRule | undefined>;
  get(id: string): Promise<AutonomyRule | undefined>;
  /** Adds or refreshes the rule; a paused one is turned back on. */
  add(tool: string, scope: AutonomyScope, origin?: AutonomyOrigin): Promise<AutonomyRule>;
  pause(id: string): Promise<boolean>;
  resume(id: string): Promise<boolean>;
  used(id: string): Promise<void>;
  list(): Promise<AutonomyRule[]>;
  revoke(id: string): Promise<boolean>;
}

function toRule(row: Record<string, unknown>): AutonomyRule {
  return {
    id: String(row.id),
    tool: String(row.tool),
    scope: String(row.scope),
    label: String(row.label),
    ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
    since: new Date(Number(row.created_ms)).toISOString(),
    uses: Number(row.uses),
    origin: row.origin === 'promoted' ? 'promoted' : 'card',
    ...(row.paused_ms !== null && row.paused_ms !== undefined ? { paused: new Date(Number(row.paused_ms)).toISOString() } : {}),
  };
}

export class SqliteAutonomyRules implements AutonomyRules {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly now: () => Date,
  ) {}

  find(tool: string, scope: string): Promise<AutonomyRule | undefined> {
    const row = this.sql.get('SELECT * FROM autonomy_rules WHERE tool = ? AND scope = ?', tool, scope);
    return Promise.resolve(row === undefined ? undefined : toRule(row));
  }

  get(id: string): Promise<AutonomyRule | undefined> {
    const row = this.sql.get('SELECT * FROM autonomy_rules WHERE id = ?', id);
    return Promise.resolve(row === undefined ? undefined : toRule(row));
  }

  async add(tool: string, scope: AutonomyScope, origin: AutonomyOrigin = 'card'): Promise<AutonomyRule> {
    this.sql.run(
      `INSERT INTO autonomy_rules (id, tool, scope, label, detail, created_ms, origin) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tool, scope) DO UPDATE SET label = excluded.label, detail = excluded.detail, origin = excluded.origin, paused_ms = NULL`,
      randomUUID(),
      tool,
      scope.key,
      scope.label,
      scope.detail ?? null,
      this.now().getTime(),
      origin,
    );
    const rule = await this.find(tool, scope.key);
    if (rule === undefined) throw new Error('autonomy rule was not stored');
    return rule;
  }

  used(id: string): Promise<void> {
    this.sql.run('UPDATE autonomy_rules SET uses = uses + 1, last_ms = ? WHERE id = ?', this.now().getTime(), id);
    return Promise.resolve();
  }

  pause(id: string): Promise<boolean> {
    const row = this.sql.get('SELECT id FROM autonomy_rules WHERE id = ? AND paused_ms IS NULL', id);
    this.sql.run('UPDATE autonomy_rules SET paused_ms = ? WHERE id = ? AND paused_ms IS NULL', this.now().getTime(), id);
    return Promise.resolve(row !== undefined);
  }

  resume(id: string): Promise<boolean> {
    const row = this.sql.get('SELECT id FROM autonomy_rules WHERE id = ? AND paused_ms IS NOT NULL', id);
    this.sql.run('UPDATE autonomy_rules SET paused_ms = NULL WHERE id = ?', id);
    return Promise.resolve(row !== undefined);
  }

  list(): Promise<AutonomyRule[]> {
    return Promise.resolve(this.sql.all('SELECT * FROM autonomy_rules ORDER BY created_ms DESC').map(toRule));
  }

  revoke(id: string): Promise<boolean> {
    const before = this.sql.get('SELECT id FROM autonomy_rules WHERE id = ?', id);
    this.sql.run('DELETE FROM autonomy_rules WHERE id = ?', id);
    return Promise.resolve(before !== undefined);
  }
}
