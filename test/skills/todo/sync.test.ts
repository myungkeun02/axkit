import { describe, expect, it } from 'vitest';
import type { SyncedTodo, SyncedTodoPatch, TodoSyncBackend } from '../../../src/core/contracts/index.js';
import type { StoredTodo } from '../../../src/skills/todo/store.js';
import type { SyncState } from '../../../src/skills/todo/sync.js';
import { EMPTY_SYNC_STATE, fingerprint, reconcile } from '../../../src/skills/todo/sync.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const NOTE = '미리 알림에서 사라져서 이 맥에만 남겨 뒀어요';
const T0 = '2026-11-16T00:00:00.000Z';
const T1 = '2026-11-16T10:00:00.000Z';
const T2 = '2026-11-16T12:00:00.000Z';

/** An in-memory Reminders list that records what the sync asked of it. */
class FakeList implements TodoSyncBackend {
  readonly label = 'fake-reminders';
  items: SyncedTodo[] = [];
  readonly calls: string[] = [];
  fail = false;
  private next = 1;
  async list(): Promise<SyncedTodo[]> {
    return this.items.map((item) => ({ ...item }));
  }
  async add(draft: { text: string; due?: string }): Promise<SyncedTodo> {
    if (this.fail) throw new Error('offline');
    const item: SyncedTodo = { id: `r${this.next++}`, text: draft.text, done: false, createdAt: T2, updatedAt: T2, ...(draft.due !== undefined ? { due: draft.due } : {}) };
    this.items.push(item);
    this.calls.push(`add ${draft.text}`);
    return { ...item };
  }
  async update(id: string, patch: SyncedTodoPatch): Promise<SyncedTodo> {
    if (this.fail) throw new Error('offline');
    this.calls.push(`update ${id} ${JSON.stringify(patch)}`);
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined) throw new Error('missing');
    if (patch.text !== undefined) item.text = patch.text;
    if (patch.due === null) delete item.due;
    else if (patch.due !== undefined) item.due = patch.due;
    if (patch.done !== undefined) item.done = patch.done;
    item.updatedAt = T2;
    return { ...item };
  }
}

const local = (id: string, text: string, extra: Partial<StoredTodo> = {}): StoredTodo => ({ id, text, done: false, createdAt: T0, ...extra });
const remote = (id: string, text: string, extra: Partial<SyncedTodo> = {}): SyncedTodo => ({ id, text, done: false, createdAt: T0, updatedAt: T0, ...extra });
const linked = (pairs: [StoredTodo, SyncedTodo][], ignored: SyncState['ignored'] = []): SyncState => ({
  links: pairs.map(([l, r]) => ({ local: l.id, remote: r.id, localFp: fingerprint(l), remoteFp: fingerprint(r) })),
  ignored,
});

let ids = 0;
async function run(locals: StoredTodo[], list: FakeList, state: SyncState = EMPTY_SYNC_STATE) {
  return reconcile({ locals, remotes: await list.list(), state, backend: list, now: NOW, newId: () => `n${++ids}`, detachedNote: NOTE });
}

describe('reconcile', () => {
  it('first sync: pushes open local items, imports open reminders, and pairs twins instead of duplicating', async () => {
    const list = new FakeList();
    list.items = [remote('r-milk', '우유 사기', { due: '2026-11-20' }), remote('r-call', '엄마께 전화'), remote('r-old', '끝난 일', { done: true })];
    const result = await run(
      [local('a', '우유 사기', { due: '2026-11-20' }), local('b', '견적서 보내기'), local('c', '이미 끝남', { done: true })],
      list,
    );
    expect(list.calls).toEqual(['add 견적서 보내기']);
    expect(result.upserts.map((item) => item.text)).toEqual(['엄마께 전화']);
    expect(result.state.links.map((link) => [link.local, link.remote])).toEqual([
      ['a', 'r-milk'],
      ['b', 'r1'],
      [result.upserts[0]?.id, 'r-call'],
    ]);
    expect(result.report).toMatchObject({ created: 1, imported: 1, pushed: 0, pulled: 0 });
  });

  it('copies a local change (completion, new due) to Reminders', async () => {
    const before = local('a', '우유 사기', { due: '2026-11-20' });
    const list = new FakeList();
    list.items = [remote('r1', '우유 사기', { due: '2026-11-20' })];
    const state = linked([[before, remote('r1', '우유 사기', { due: '2026-11-20' })]]);
    const result = await run([{ ...before, done: true, completedAt: T1, updatedAt: T1 }], list, state);
    expect(list.calls).toEqual(['update r1 {"done":true}']);
    expect(result.report.pushed).toBe(1);

    const again = await run([{ ...before, done: true, completedAt: T1, updatedAt: T1 }], list, result.state);
    expect(list.calls).toHaveLength(1);
    expect(again.report).toMatchObject({ pushed: 0, pulled: 0 });
  });

  it('copies a change made in Reminders here and keeps the local reminder time', async () => {
    const before = local('a', '우유 사기', { remindAt: '2026-11-20T09:00:00+09:00' });
    const list = new FakeList();
    list.items = [remote('r1', '두유 사기', { due: '2026-11-21T15:00:00+09:00', updatedAt: T1 })];
    const result = await run([before], list, linked([[before, remote('r1', '우유 사기')]]));
    expect(result.upserts).toEqual([
      { ...before, text: '두유 사기', due: '2026-11-21T15:00:00+09:00', updatedAt: T1 },
    ]);
    expect(list.calls).toEqual([]);
  });

  it('resolves a conflict by the newer change: Reminders newer wins', async () => {
    const base = local('a', '우유 사기');
    const list = new FakeList();
    list.items = [remote('r1', 'Reminders에서 고침', { updatedAt: T2 })];
    const result = await run([{ ...base, text: '여기서 고침', updatedAt: T1 }], list, linked([[base, remote('r1', '우유 사기')]]));
    expect(result.report.conflicts).toBe(1);
    expect(result.upserts[0]?.text).toBe('Reminders에서 고침');
    expect(list.calls).toEqual([]);
  });

  it('resolves a conflict by the newer change: local newer wins', async () => {
    const base = local('a', '우유 사기');
    const list = new FakeList();
    list.items = [remote('r1', 'Reminders에서 고침', { updatedAt: T1 })];
    const result = await run([{ ...base, done: true, completedAt: T2, updatedAt: T2 }], list, linked([[base, remote('r1', '우유 사기')]]));
    expect(result.report.conflicts).toBe(1);
    expect(list.calls).toEqual(['update r1 {"text":"우유 사기","done":true}']);
    expect(result.upserts).toEqual([]);
  });

  it('never deletes here when a reminder vanished: the item is marked and not recreated', async () => {
    const item = local('a', '우유 사기');
    const done = local('b', '끝난 일', { done: true });
    const list = new FakeList();
    list.items = [remote('r-other', '다른 일')];
    const state = linked([[item, remote('r1', '우유 사기')], [done, remote('r2', '끝난 일', { done: true })]]);
    const result = await run([item, done], list, state);
    expect(result.upserts.find((entry) => entry.id === 'a')).toEqual({ ...item, note: NOTE });
    expect(result.upserts.find((entry) => entry.id === 'b')).toBeUndefined();
    expect(result.report.detached).toBe(1);
    expect(list.calls).toEqual([]);

    const next = await run([{ ...item, note: NOTE }, done], list, result.state);
    expect(list.calls).toEqual([]);
    expect(next.report.detached).toBe(0);
  });

  it('never deletes in Reminders when the item was deleted here; brings it back only if it changes there', async () => {
    const item = local('a', '우유 사기');
    const list = new FakeList();
    list.items = [remote('r1', '우유 사기')];
    const result = await run([], list, linked([[item, remote('r1', '우유 사기')]]));
    expect(list.items).toHaveLength(1);
    expect(result.upserts).toEqual([]);
    expect(result.state.ignored).toEqual([{ remote: 'r1', updatedAt: T0 }]);

    const quiet = await run([], list, result.state);
    expect(quiet.upserts).toEqual([]);

    list.items[0] = { ...remote('r1', '우유 두 개 사기'), updatedAt: T2 };
    const changed = await run([], list, quiet.state);
    expect(changed.upserts.map((entry) => entry.text)).toEqual(['우유 두 개 사기']);
    expect(changed.state.ignored).toEqual([]);
  });

  it('treats an empty Reminders list while links exist as a failed read and marks nothing', async () => {
    const item = local('a', '우유 사기');
    const state = linked([[item, remote('r1', '우유 사기')]]);
    const result = await run([item], new FakeList(), state);
    expect(result.upserts).toEqual([]);
    expect(result.state.links).toEqual(state.links);
  });

  it('keeps going when one write fails and retries it next time', async () => {
    const base = local('a', '우유 사기');
    const list = new FakeList();
    list.items = [remote('r1', '우유 사기')];
    list.fail = true;
    const state = linked([[base, remote('r1', '우유 사기')]]);
    const result = await run([{ ...base, done: true, updatedAt: T1 }, local('b', '새 일')], list, state);
    expect(result.report.failed).toBe(2);
    expect(result.state.links).toEqual(state.links);
    list.fail = false;
    const retry = await run([{ ...base, done: true, updatedAt: T1 }, local('b', '새 일')], list, result.state);
    expect(retry.report).toMatchObject({ pushed: 1, created: 1, failed: 0 });
  });

  it('compares due times by instant, so a different offset is not a change', () => {
    expect(fingerprint({ text: 'a', due: '2026-11-20T15:00:00+09:00', done: false })).toBe(
      fingerprint({ text: 'a ', due: '2026-11-20T06:00:00Z', done: false }),
    );
  });
});
