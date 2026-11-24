import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { todoSkill } from '../../../src/skills/todo/plugin.js';
import type { StoredTodo } from '../../../src/skills/todo/store.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

async function setup(seed?: StoredTodo[]) {
  const context = createTestContext({ now: NOW });
  if (seed !== undefined) await context.kv.set('items', seed);
  await todoSkill().setup(context.ctx);
  return context;
}

describe('todo.write capability', () => {
  it('adds trimmed text with an id and the injected clock time', async () => {
    const context = await setup();

    const item = await context.ctx.use(Contracts.todoWrite).add({
      text: '  우유 사기  ',
      due: '2026-11-20',
      remindAt: '2026-11-20T09:00:00+09:00',
    });

    expect(item).toMatchObject({
      text: '우유 사기',
      due: '2026-11-20',
      remindAt: '2026-11-20T09:00:00+09:00',
      done: false,
      createdAt: NOW.toISOString(),
    });
    expect(item.id).toHaveLength(8);
    expect(await context.kv.get<StoredTodo[]>('items')).toEqual([item]);
  });

  it('rejects text outside one to two hundred characters', async () => {
    const writer = (await setup()).ctx.use(Contracts.todoWrite);

    await expect(writer.add({ text: '   ' })).rejects.toThrow(/1 to 200/);
    await expect(writer.add({ text: 'a'.repeat(201) })).rejects.toThrow(/1 to 200/);
  });

  it('rejects due and remind values that are not dates', async () => {
    const writer = (await setup()).ctx.use(Contracts.todoWrite);

    await expect(writer.add({ text: '보고서', due: '내일' })).rejects.toThrow(/due/);
    await expect(writer.add({ text: '보고서', remindAt: 'soon' })).rejects.toThrow(/remindAt/);
  });
});

describe('todo.read capability', () => {
  const SEED: StoredTodo[] = [
    { id: 'early', text: '일찍 끝난 일', done: true, createdAt: '2026-11-01T00:00:00.000Z', completedAt: '2026-11-16T10:00:00.000Z' },
    { id: 'at', text: '경계', done: true, createdAt: '2026-11-01T00:00:00.000Z', completedAt: '2026-11-17T00:00:00.000Z' },
    { id: 'late', text: '늦게 끝난 일', done: true, createdAt: '2026-11-01T00:00:00.000Z', completedAt: '2026-11-17T05:00:00.000Z' },
    { id: 'open', text: '열린 일', done: false, createdAt: '2026-11-01T00:00:00.000Z' },
  ];

  it('returns completed items at or after the given instant', async () => {
    const context = await setup(SEED);

    const done = await context.ctx.use(Contracts.todoRead).doneSince(new Date('2026-11-17T00:00:00.000Z'));

    expect(done.map((item) => item.id)).toEqual(['at', 'late']);
    expect(done[0]?.completedAt).toBe('2026-11-17T00:00:00.000Z');
  });
});
