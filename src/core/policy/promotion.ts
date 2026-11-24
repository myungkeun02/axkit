import type { Migration, SqlDatabase } from '../store/types.js';
import type { Effect } from './types.js';

/**
 * How the owner answered cards of one autonomy scope (tool + scope key), so a kind of action the owner always
 * approved can be offered to run on its own ("자동 실행 승격"). Fed by the executor: when a card is answered, when the
 * action finishes, and when the owner later says it was wrong.
 */
export const PROMOTION_MIGRATIONS: readonly Migration[] = [
  {
    id: 'core/011-autonomy-track',
    sql: `CREATE TABLE IF NOT EXISTS autonomy_track (tool TEXT NOT NULL, scope TEXT NOT NULL, label TEXT NOT NULL, detail TEXT, recipient TEXT, effects TEXT NOT NULL DEFAULT '',
  approved INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, corrected INTEGER NOT NULL DEFAULT 0,
  recent TEXT NOT NULL DEFAULT '', ask_state TEXT NOT NULL DEFAULT 'none', ask_after INTEGER NOT NULL DEFAULT 0, auto_fails INTEGER NOT NULL DEFAULT 0, last_ms INTEGER,
  PRIMARY KEY (tool, scope));
CREATE TABLE IF NOT EXISTS autonomy_recipients (recipient TEXT PRIMARY KEY, seen INTEGER NOT NULL DEFAULT 0);`,
  },
];

/** At least this many clean approvals of the same scope before the owner is offered "do it on your own". */
export const PROMOTE_MIN_APPROVALS = 20;
/** Share of the scope's decisions that were approvals the owner never corrected afterwards. */
export const PROMOTE_MIN_RATE = 0.95;
/** None of the last this many decisions may be a no (or a typed change). */
export const PROMOTE_RECENT_WINDOW = 10;
/** "Not now" asks again after this many more clean approvals. */
export const PROMOTE_ASK_AGAIN_AFTER = 30;
/** A send scope's recipient must have been sent to at least this many times. */
export const PROMOTE_MIN_RECIPIENT_SEEN = 3;
/** A promoted rule pauses after this many failures in a row. */
export const DEMOTE_FAILS_IN_A_ROW = 2;

/** none = never asked; asking = a card is out; later = "not now"; never; yes = a rule was made; paused = demoted. */
export type AskState = 'none' | 'asking' | 'later' | 'never' | 'yes' | 'paused';

export interface ScopeTrack {
  tool: string;
  scope: string;
  label: string;
  detail?: string;
  recipient?: string;
  effects: readonly Effect[];
  /** Cards answered yes. */
  approved: number;
  denied: number;
  /** Answered with a typed change instead of yes. */
  edited: number;
  /** Approved but the action failed. */
  failed: number;
  /** Approved and done, then the owner undid it or said it was wrong. */
  corrected: number;
  /** The latest decisions, oldest first: a = yes, d = no, e = typed change. */
  recent: string;
  askState: AskState;
  /** For `later`: ask again once `clean` reaches this. */
  askAfter: number;
  /** Failures in a row of actions run under the scope's rule. */
  autoFails: number;
}

/** Approvals that ran and were never corrected. */
export function cleanApprovals(track: ScopeTrack): number {
  return Math.max(0, track.approved - track.failed - track.corrected);
}

export type PromotionVerdict =
  | { ok: true; clean: number; total: number }
  | { ok: false; reason: 'pay_delete' | 'uncertain' | 'too_few' | 'rate' | 'recent_no' | 'recipient' };

/**
 * Pure: whether a scope may be offered to run on its own. Never for pay or delete, never for a guessed input, never
 * for a send to someone barely known; otherwise many approvals, nearly all clean, and no recent no.
 */
export function promotionVerdict(track: ScopeTrack, opts: { uncertain?: boolean; recipientSeen?: number }): PromotionVerdict {
  if (track.effects.includes('pay') || track.effects.includes('delete') || track.effects.includes('system')) return { ok: false, reason: 'pay_delete' };
  if (opts.uncertain === true) return { ok: false, reason: 'uncertain' };
  const clean = cleanApprovals(track);
  if (clean < PROMOTE_MIN_APPROVALS) return { ok: false, reason: 'too_few' };
  const total = track.approved + track.denied + track.edited;
  if (total === 0 || clean / total < PROMOTE_MIN_RATE) return { ok: false, reason: 'rate' };
  if (/[de]/.test(track.recent.slice(-PROMOTE_RECENT_WINDOW))) return { ok: false, reason: 'recent_no' };
  if (track.effects.includes('send')) {
    // the exact-repeat default scope names its recipient in the action itself, approved this many times
    const exact = track.scope.startsWith('same:');
    if (!exact && (track.recipient === undefined || (opts.recipientSeen ?? 0) < PROMOTE_MIN_RECIPIENT_SEEN)) {
      return { ok: false, reason: 'recipient' };
    }
  }
  return { ok: true, clean, total };
}

export interface TrackScope {
  tool: string;
  scope: string;
  label: string;
  detail?: string;
  recipient?: string;
  effects: readonly Effect[];
}

export type TrackCounter = 'approved' | 'denied' | 'edited' | 'failed' | 'corrected';

const RECENT_MARK: Partial<Record<TrackCounter, string>> = { approved: 'a', denied: 'd', edited: 'e' };
const ASK_STATES: readonly AskState[] = ['none', 'asking', 'later', 'never', 'yes', 'paused'];

function toTrack(row: Record<string, unknown>): ScopeTrack {
  const state = String(row.ask_state) as AskState;
  return {
    tool: String(row.tool),
    scope: String(row.scope),
    label: String(row.label),
    ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
    ...(typeof row.recipient === 'string' ? { recipient: row.recipient } : {}),
    effects: String(row.effects).split(',').filter((effect) => effect !== '') as Effect[],
    approved: Number(row.approved),
    denied: Number(row.denied),
    edited: Number(row.edited),
    failed: Number(row.failed),
    corrected: Number(row.corrected),
    recent: String(row.recent),
    askState: ASK_STATES.includes(state) ? state : 'none',
    askAfter: Number(row.ask_after),
    autoFails: Number(row.auto_fails),
  };
}

export class SqliteScopeTracks {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly now: () => Date,
  ) {}

  get(tool: string, scope: string): ScopeTrack | undefined {
    const row = this.sql.get('SELECT * FROM autonomy_track WHERE tool = ? AND scope = ?', tool, scope);
    return row === undefined ? undefined : toTrack(row);
  }

  /** The scope of this tool that finished last (what "that was wrong" most likely means). */
  latest(tool: string): ScopeTrack | undefined {
    const row = this.sql.get('SELECT * FROM autonomy_track WHERE tool = ? AND last_ms IS NOT NULL ORDER BY last_ms DESC LIMIT 1', tool);
    return row === undefined ? undefined : toTrack(row);
  }

  /** Counts one event; a decision also joins `recent` (the last 20 are kept). */
  count(scope: TrackScope, counter: TrackCounter): ScopeTrack {
    this.ensure(scope);
    const mark = RECENT_MARK[counter] ?? '';
    this.sql.run(
      `UPDATE autonomy_track SET ${counter} = ${counter} + 1, recent = substr(recent || ?, -20), label = ?, detail = ?, recipient = COALESCE(?, recipient), effects = ?
       WHERE tool = ? AND scope = ?`,
      mark,
      scope.label,
      scope.detail ?? null,
      scope.recipient ?? null,
      scope.effects.join(','),
      scope.tool,
      scope.scope,
    );
    return this.must(scope);
  }

  /** The action finished (on a card or on its own); a run under a rule tracks its failures in a row. */
  finished(scope: TrackScope, auto: { ok: boolean } | undefined): ScopeTrack {
    this.ensure(scope);
    const fails = auto === undefined ? 'auto_fails' : auto.ok ? '0' : 'auto_fails + 1';
    this.sql.run(`UPDATE autonomy_track SET last_ms = ?, auto_fails = ${fails} WHERE tool = ? AND scope = ?`, this.now().getTime(), scope.tool, scope.scope);
    return this.must(scope);
  }

  setAsk(tool: string, scope: string, state: AskState, askAfter?: number): void {
    this.sql.run(
      'UPDATE autonomy_track SET ask_state = ?, ask_after = COALESCE(?, ask_after) WHERE tool = ? AND scope = ?',
      state,
      askAfter ?? null,
      tool,
      scope,
    );
  }

  /** Moves the ask state only from `from`, so two finishing actions never put out two cards. */
  claimAsk(tool: string, scope: string, from: AskState): boolean {
    const row = this.sql.get('SELECT ask_state FROM autonomy_track WHERE tool = ? AND scope = ? AND ask_state = ?', tool, scope, from);
    if (row === undefined) return false;
    this.sql.run("UPDATE autonomy_track SET ask_state = 'asking' WHERE tool = ? AND scope = ?", tool, scope);
    return true;
  }

  sawRecipient(recipient: string): void {
    this.sql.run(
      'INSERT INTO autonomy_recipients (recipient, seen) VALUES (?, 1) ON CONFLICT (recipient) DO UPDATE SET seen = seen + 1',
      recipient.trim().toLowerCase(),
    );
  }

  recipientSeen(recipient: string | undefined): number {
    if (recipient === undefined) return 0;
    const row = this.sql.get('SELECT seen FROM autonomy_recipients WHERE recipient = ?', recipient.trim().toLowerCase());
    return row === undefined ? 0 : Number(row.seen);
  }

  private ensure(scope: TrackScope): void {
    this.sql.run(
      'INSERT INTO autonomy_track (tool, scope, label, detail, recipient, effects) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tool, scope) DO NOTHING',
      scope.tool,
      scope.scope,
      scope.label,
      scope.detail ?? null,
      scope.recipient ?? null,
      scope.effects.join(','),
    );
  }

  private must(scope: TrackScope): ScopeTrack {
    const track = this.get(scope.tool, scope.scope);
    if (track === undefined) throw new Error('autonomy track was not stored');
    return track;
  }
}
