import { describe, expect, it } from 'vitest';
import type { SyncedTodo, SyncedTodoPatch, TodoItem, TodoSyncBackend } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { SYNC_JOB, todoSkill } from '../../../src/skills/todo/plugin.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

class FakeReminders implements TodoSyncBackend {
  readonly label = 'apple-reminders';
  items: SyncedTodo[] = [];
  down = false;
  lists = 0;
  private next = 1;
  async list(): Promise<SyncedTodo[]> {
    this.lists += 1;
    if (this.down) throw new Error('미리 알림 접근이 허용되지 않았어요.');
    return this.items.map((item) => ({ ...item }));
  }
  async add(draft: { text: string; due?: string }): Promise<SyncedTodo> {
    const item: SyncedTodo = { id: `r${this.next++}`, text: draft.text, done: false, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...(draft.due !== undefined ? { due: draft.due } : {}) };
    this.items.push(item);
    return { ...item };
  }
  async update(id: string, patch: SyncedTodoPatch): Promise<SyncedTodo> {
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined) throw new Error('missing');
    if (patch.done !== undefined) item.done = patch.done;
    if (patch.text !== undefined) item.text = patch.text;
    return { ...item };
  }
}

async function setup(backend = new FakeReminders()) {
  const context = createTestContext({ now: NOW, capabilities: { [Contracts.todoSync.id]: backend } });
  const plugin = todoSkill({ source: 'synced' });
  const instance = await plugin.setup(context.ctx);
  return { context, backend, plugin, instance };
}

function output<T>(outcome: { status: string; output?: unknown }): T {
  if (outcome.status !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
  return outcome.output as T;
}

describe('to-do skill synced with Apple Reminders', () => {
  it('needs todo.sync and registers the 10-minute sync job', async () => {
    expect(todoSkill({ source: 'synced' }).manifest.needs).toEqual([Contracts.todoSync]);
    const { context } = await setup();
    expect(context.scheduler.jobs.get(SYNC_JOB)?.schedule).toEqual({ kind: 'every', seconds: 600 });
  });

  it('keeps the list here, pushes new items and pulls changes both ways', async () => {
    const { context, backend } = await setup();
    const added = output<TodoItem>(await context.ctx.tools.execute('todo.add', { text: '견적서 보내기' }, { grounding: [] }));
    expect(await context.kv.get('items')).toHaveLength(1);

    await context.scheduler.run(SYNC_JOB, NOW);
    expect(backend.items.map((item) => item.text)).toEqual(['견적서 보내기']);

    backend.items.push({ id: 'phone', text: '아이폰에서 넣은 일', done: false, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    const first = backend.items[0];
    if (first !== undefined) Object.assign(first, { done: true, completedAt: NOW.toISOString(), updatedAt: '2026-11-17T01:00:00.000Z' });
    await context.scheduler.run(SYNC_JOB, NOW);

    const open = await context.ctx.use(Contracts.todoRead).open();
    expect(open.map((item) => item.text)).toEqual(['아이폰에서 넣은 일']);
    const doneSince = await context.ctx.use(Contracts.todoRead).doneSince(new Date('2026-11-16T00:00:00Z'));
    expect(doneSince.map((item) => item.id)).toEqual([added.id]);
  });

  it('pushes a completion made here on the next sync', async () => {
    const { context, backend } = await setup();
    const added = output<TodoItem>(await context.ctx.tools.execute('todo.add', { text: '우유 사기' }, { grounding: [] }));
    await context.scheduler.run(SYNC_JOB, NOW);
    await context.ctx.tools.execute('todo.complete', { id: added.id }, { grounding: [] });
    await context.scheduler.run(SYNC_JOB, NOW);
    expect(backend.items[0]?.done).toBe(true);
  });

  it('keeps working on the local copy when Reminders cannot be reached', async () => {
    const backend = new FakeReminders();
    backend.down = true;
    const { context, instance } = await setup(backend);
    await instance?.start?.();
    output(await context.ctx.tools.execute('todo.add', { text: '오프라인 할 일' }, { grounding: [] }));
    const listed = output<TodoItem[]>(await context.ctx.tools.execute('todo.list', {}, { grounding: [] }));
    expect(listed.map((item) => item.text)).toEqual(['오프라인 할 일']);
    await expect(context.scheduler.run(SYNC_JOB, NOW)).rejects.toThrow('미리 알림');
  });

  it('shows the mark on an item that vanished from Reminders, and deleting here leaves Reminders alone', async () => {
    const { context, backend } = await setup();
    const kept = output<TodoItem>(await context.ctx.tools.execute('todo.add', { text: '남길 일' }, { grounding: [] }));
    const gone = output<TodoItem>(await context.ctx.tools.execute('todo.add', { text: '지울 일' }, { grounding: [] }));
    await context.scheduler.run(SYNC_JOB, NOW);

    backend.items = backend.items.filter((item) => item.text !== '남길 일');
    await context.ctx.tools.execute('todo.remove', { id: gone.id }, { grounding: [] });
    await context.scheduler.run(SYNC_JOB, NOW);

    const listed = output<TodoItem[]>(await context.ctx.tools.execute('todo.list', {}, { grounding: [] }));
    expect(listed).toEqual([expect.objectContaining({ id: kept.id, note: '미리 알림에서 사라져서 이 맥에만 남겨 뒀어요' })]);
    expect(backend.items.map((item) => item.text)).toEqual(['지울 일']);
  });

  it('syncs at most every 30 seconds for fresh reads', async () => {
    const { context, backend } = await setup();
    await context.ctx.tools.execute('todo.list', {}, { grounding: [] });
    await context.ctx.tools.execute('todo.list', {}, { grounding: [] });
    expect(backend.lists).toBe(1);
    await context.clock.advance(31_000);
    await context.ctx.tools.execute('todo.list', {}, { grounding: [] });
    expect(backend.lists).toBe(2);
  });
});
