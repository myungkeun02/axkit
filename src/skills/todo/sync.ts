import type { SyncedTodo, SyncedTodoPatch, TodoSyncBackend } from '../../core/contracts/index.js';
import type { StoredTodo } from './store.js';

/** One local item and the outside item it mirrors, with what both looked like after the last sync. */
export interface SyncLink {
  local: string;
  remote: string;
  localFp: string;
  remoteFp: string;
}

/** An outside item left alone because the owner deleted its local copy; it comes back only if it changes there. */
export interface IgnoredRemote {
  remote: string;
  updatedAt: string;
}

export interface SyncState {
  links: SyncLink[];
  ignored: IgnoredRemote[];
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  created: number;
  imported: number;
  detached: number;
  conflicts: number;
  failed: number;
}

export interface ReconcileInput {
  locals: readonly StoredTodo[];
  remotes: readonly SyncedTodo[];
  state: SyncState;
  backend: TodoSyncBackend;
  now: Date;
  newId: () => string;
  /** Put on a local item whose outside copy vanished; the item itself is kept. */
  detachedNote: string;
}

export interface ReconcileResult {
  state: SyncState;
  /** Local items to write (changed or new). Nothing local is ever deleted by a sync. */
  upserts: StoredTodo[];
  report: SyncReport;
}

export const EMPTY_SYNC_STATE: SyncState = { links: [], ignored: [] };

function normalDue(due: string | undefined): string {
  if (due === undefined) return '';
  if (!due.includes('T')) return due.slice(0, 10);
  const time = Date.parse(due);
  return Number.isNaN(time) ? due : new Date(time).toISOString();
}

const normalText = (text: string): string => text.normalize('NFC').trim();

/** What a sync compares: the text, the due date or time, and whether it is done. */
export function fingerprint(item: { text: string; due?: string; done: boolean }): string {
  return JSON.stringify([normalText(item.text), normalDue(item.due), item.done]);
}

const time = (iso: string | undefined): number => {
  const parsed = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** The local item changed to match the outside one; local-only state (the reminder) is kept. */
function pulled(local: StoredTodo, remote: SyncedTodo, now: Date): StoredTodo {
  const rest: StoredTodo = { ...local };
  delete rest.due;
  delete rest.completedAt;
  delete rest.note;
  const completedAt = remote.done ? (remote.completedAt ?? local.completedAt ?? now.toISOString()) : undefined;
  return {
    ...rest,
    text: remote.text,
    done: remote.done,
    updatedAt: remote.updatedAt,
    ...(remote.due !== undefined ? { due: remote.due } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

function patchFor(local: StoredTodo, remote: SyncedTodo): SyncedTodoPatch {
  const patch: SyncedTodoPatch = {};
  if (normalText(local.text) !== normalText(remote.text)) patch.text = local.text;
  if (normalDue(local.due) !== normalDue(remote.due)) patch.due = local.due ?? null;
  if (local.done !== remote.done) patch.done = local.done;
  return patch;
}

function imported(remote: SyncedTodo, id: string): StoredTodo {
  return {
    id,
    text: remote.text,
    done: false,
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    ...(remote.due !== undefined ? { due: remote.due } : {}),
  };
}

/**
 * Two-way reconcile of the local list with an outside list. Rules:
 * - a change on one side is copied to the other; when both changed, the newer change wins;
 * - an item missing on one side is never deleted on the other: a vanished outside item marks the local one, and a
 *   locally deleted item leaves the outside one alone (ignored until it changes there);
 * - open items without a partner are created on the other side (matched by text and due date first);
 * - an empty outside list while links exist is taken as a failed read, so nothing is marked missing.
 */
export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const { backend, now } = input;
  const report: SyncReport = { pushed: 0, pulled: 0, created: 0, imported: 0, detached: 0, conflicts: 0, failed: 0 };
  const locals = new Map(input.locals.map((item) => [item.id, item]));
  const remotes = new Map(input.remotes.map((item) => [item.id, item]));
  const suspicious = input.remotes.length === 0 && input.state.links.length > 0;
  const upserts = new Map<string, StoredTodo>();
  const links: SyncLink[] = [];
  const ignored = new Map(input.state.ignored.map((entry) => [entry.remote, entry]));

  for (const link of input.state.links) {
    const local = locals.get(link.local);
    const remote = remotes.get(link.remote);
    if (local === undefined) {
      ignored.set(link.remote, { remote: link.remote, updatedAt: remote?.updatedAt ?? now.toISOString() });
      continue;
    }
    if (remote === undefined) {
      if (suspicious) links.push(link);
      else if (!local.done && local.note !== input.detachedNote) {
        upserts.set(local.id, { ...local, note: input.detachedNote });
        report.detached += 1;
      }
      continue;
    }
    const localFp = fingerprint(local);
    const remoteFp = fingerprint(remote);
    const localChanged = localFp !== link.localFp;
    const remoteChanged = remoteFp !== link.remoteFp;
    if (localFp === remoteFp || (!localChanged && !remoteChanged)) {
      links.push({ ...link, localFp, remoteFp });
      continue;
    }
    if (localChanged && remoteChanged) report.conflicts += 1;
    const pull = remoteChanged && (!localChanged || time(remote.updatedAt) > time(local.updatedAt ?? local.createdAt));
    if (pull) {
      const next = pulled(local, remote, now);
      upserts.set(next.id, next);
      report.pulled += 1;
      links.push({ ...link, localFp: fingerprint(next), remoteFp });
      continue;
    }
    try {
      const updated = await backend.update(remote.id, patchFor(local, remote));
      report.pushed += 1;
      links.push({ ...link, localFp, remoteFp: fingerprint(updated) });
    } catch {
      report.failed += 1;
      links.push(link);
    }
  }

  const linkedLocal = new Set(links.map((link) => link.local));
  const linkedRemote = new Set(links.map((link) => link.remote));
  const free = input.remotes.filter((remote) => !linkedRemote.has(remote.id) && !remote.done);

  for (const local of input.locals) {
    // A detached item stays on this Mac only: recreating it would undo a deletion made in the outside list.
    if (linkedLocal.has(local.id) || local.done || (upserts.get(local.id) ?? local).note === input.detachedNote) continue;
    const fp = fingerprint(local);
    const twin = free.findIndex((remote) => fingerprint(remote) === fp);
    const remote = twin >= 0 ? free.splice(twin, 1)[0] : undefined;
    if (remote !== undefined) {
      links.push({ local: local.id, remote: remote.id, localFp: fp, remoteFp: fp });
      ignored.delete(remote.id);
      continue;
    }
    try {
      const created = await backend.add({ text: local.text, ...(local.due !== undefined ? { due: local.due } : {}) });
      report.created += 1;
      links.push({ local: local.id, remote: created.id, localFp: fp, remoteFp: fingerprint(created) });
    } catch {
      report.failed += 1;
    }
  }

  for (const remote of free) {
    const skip = ignored.get(remote.id);
    if (skip !== undefined && time(remote.updatedAt) <= time(skip.updatedAt)) continue;
    ignored.delete(remote.id);
    const item = imported(remote, input.newId());
    upserts.set(item.id, item);
    report.imported += 1;
    links.push({ local: item.id, remote: remote.id, localFp: fingerprint(item), remoteFp: fingerprint(remote) });
  }

  // Forget ignored items that are gone from the outside list (unless the read looked broken).
  const keptIgnored = [...ignored.values()].filter((entry) => suspicious || remotes.has(entry.remote));
  return { state: { links, ignored: keptIgnored }, upserts: [...upserts.values()], report };
}
