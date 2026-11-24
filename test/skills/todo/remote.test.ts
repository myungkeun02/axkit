import { describe, expect, it } from 'vitest';
import type { Notice, NoticeResult, Notifier, TodoBackend, TodoItem } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { todoSkill } from '../../../src/skills/todo/plugin.js';
import { REMINDER_JOB } from '../../../src/skills/todo/reminders.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

/** An in-memory Google Tasks stand-in that counts list calls. */
class FakeBackend implements TodoBackend {
  readonly label = 'fake';
  items: TodoItem[] = [];
  lists = 0;
  private next = 1;

  async list(): Promise<TodoItem[]> {
    this.lists += 1;
    return this.items.map((item) => ({ ...item }));
  }
  async add(draft: { text: string; due?: string }): Promise<TodoItem> {
    const item: TodoItem = {
      id: `g${this.next++}`,
      text: draft.text,
      done: false,
      createdAt: NOW.toISOString(),
      ...(draft.due !== undefined ? { due: draft.due.slice(0, 10) } : {}),
    };
    this.items.push(item);
    return { ...item };
  }
  async complete(id: string): Promise<TodoItem> {
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined) throw new Error('missing');
    Object.assign(item, { done: true, completedAt: '2026-11-17T00:30:00.000Z' });
    return { ...item };
  }
  async remove(id: string): Promise<void> {
    this.items = this.items.filter((entry) => entry.id !== id);
  }
}

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

async function setup(backend = new FakeBackend(), notifier?: FakeNotifier) {
  const context = createTestContext({
    now: NOW,
    capabilities: {
      [Contracts.todoBackend.id]: backend,
      ...(notifier !== undefined ? { [Contracts.notifier.id]: notifier } : {}),
    },
  });
  await context.kv.set('items', [{ id: 'local1', text: '이 맥의 할 일', done: false, createdAt: NOW.toISOString() }]);
  const plugin = todoSkill({ source: 'backend' });
  await plugin.setup(context.ctx);
  return { context, backend, plugin };
}

function output<T>(outcome: { status: string; output?: unknown }): T {
  if (outcome.status !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
  return outcome.output as T;
}

describe('to-do skill over Google Tasks', () => {
  it('needs the backend capability only in backend mode', () => {
    expect(todoSkill({ source: 'backend' }).manifest.needs).toEqual([Contracts.todoBackend]);
    expect(todoSkill().manifest.needs).toBeUndefined();
  });

  it('adds, lists and completes through the backend, leaving the local list alone', async () => {
    const { context, backend } = await setup();
    backend.items.push({ id: 'g0', text: 'Tasks 앱에서 넣은 일', done: false, createdAt: NOW.toISOString() });

    const added = output<TodoItem>(await context.ctx.tools.execute('todo.add', { text: '견적서 보내기' }, { grounding: [] }));
    expect(added.id).toBe('g1');

    const listed = output<TodoItem[]>(await context.ctx.tools.execute('todo.list', {}, { grounding: [] }));
    expect(listed.map((item) => item.text)).toEqual(['Tasks 앱에서 넣은 일', '견적서 보내기']);

    const done = output<TodoItem>(await context.ctx.tools.execute('todo.complete', { id: 'g0' }, { grounding: [] }));
    expect(done).toMatchObject({ id: 'g0', done: true });
    expect(backend.items.find((item) => item.id === 'g0')?.done).toBe(true);
    expect(await context.kv.get('items')).toHaveLength(1);
  });

  it('keeps the due time and reminder on this Mac and reminds once', async () => {
    const notifier = new FakeNotifier();
    const { context, backend } = await setup(new FakeBackend(), notifier);
    const writer = context.ctx.use(Contracts.todoWrite);

    const item = await writer.add({ text: '보고서', due: '2026-11-17T15:00:00+09:00', remindAt: '2026-11-17T08:30:00+09:00' });

    expect(backend.items[0]?.due).toBe('2026-11-17');
    expect(item).toMatchObject({ id: 'g1', due: '2026-11-17T15:00:00+09:00', remindAt: '2026-11-17T08:30:00+09:00' });
    expect(await context.kv.get('remote-extras')).toEqual({ g1: { due: '2026-11-17T15:00:00+09:00', remindAt: '2026-11-17T08:30:00+09:00' } });

    await context.scheduler.run(REMINDER_JOB, NOW);
    await context.scheduler.run(REMINDER_JOB, NOW);
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.text).toContain('보고서');
  });

  it('reads open items for the briefing from the backend, refreshing at most once a minute', async () => {
    const { context, backend } = await setup();
    backend.items.push({ id: 'g5', text: '열린 일', done: false, createdAt: NOW.toISOString() });
    const reader = context.ctx.use(Contracts.todoRead);

    expect((await reader.open()).map((item) => item.id)).toEqual(['g5']);
    await reader.open();
    expect(backend.lists).toBe(1);

    await context.clock.advance(61_000);
    await reader.open();
    expect(backend.lists).toBe(2);
  });

  it('removes through the backend after the owner approves', async () => {
    const { context, backend } = await setup();
    backend.items.push({ id: 'g7', text: '지울 일', done: false, createdAt: NOW.toISOString() });

    const outcome = await context.ctx.tools.execute('todo.remove', { id: 'g7' }, { grounding: [] });

    expect(output<{ removed: boolean }>(outcome).removed).toBe(true);
    expect(backend.items).toEqual([]);
  });

  it('shows a clear error when the backend fails', async () => {
    const backend = new FakeBackend();
    backend.list = async () => {
      throw new Error('Google Tasks(할 일) 권한이 아직 없어요.');
    };
    const { context } = await setup(backend);

    const outcome = await context.ctx.tools.execute('todo.list', {}, { grounding: [] });

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(outcome)).toContain('권한이 아직 없어요');
  });
});
