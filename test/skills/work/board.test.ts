import { describe, expect, it } from 'vitest';
import type { AppView, WorkItem } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { KvWorkBoard } from '../../../src/skills/work/board.js';
import { Lane } from '../../../src/skills/work/lane.js';
import type { WorkStatusOutput } from '../../../src/skills/work/plugin.js';
import { workSkill } from '../../../src/skills/work/plugin.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-23T09:00:00+09:00');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function item(overrides: Partial<WorkItem>): WorkItem {
  return { id: 'dev:job_1', kind: 'dev', title: 'owner/repo: Fix it', status: 'running', startedAt: minutesAgo(12), updatedAt: minutesAgo(1), ...overrides };
}

describe('work board', () => {
  it('lists active work first and finished work by last update', async () => {
    const board = new KvWorkBoard(new MapKeyValueStore(), () => NOW);
    await board.upsert(item({ id: 'a', status: 'done', updatedAt: minutesAgo(30) }));
    await board.upsert(item({ id: 'b', status: 'running', startedAt: minutesAgo(5) }));
    await board.upsert(item({ id: 'c', status: 'failed', updatedAt: minutesAgo(2) }));
    await board.upsert(item({ id: 'd', status: 'queued', startedAt: minutesAgo(1) }));
    await board.upsert(item({ id: 'e', status: 'waiting', updatedAt: minutesAgo(26 * 60) }));
    await board.upsert(item({ id: 'b', status: 'running', phase: '테스트 중', startedAt: minutesAgo(5) }));

    expect((await board.list()).map((entry) => entry.id)).toEqual(['d', 'b', 'c', 'a', 'e']);
    expect((await board.get('b'))?.phase).toBe('테스트 중');
  });

  it('turns work left running at a restart into interrupted', async () => {
    const kv = new MapKeyValueStore();
    await kv.set('items', [item({ id: 'a', status: 'running' }), item({ id: 'b', status: 'done' }), { broken: true }]);
    const board = new KvWorkBoard(kv, () => NOW);
    await board.load();
    expect((await board.list()).map((entry) => [entry.id, entry.status])).toEqual([
      ['a', 'interrupted'],
      ['b', 'done'],
    ]);
  });
});

describe('work.status and the work view', () => {
  it('answers "어떻게 됐어?" with what is running and what finished, and serves the app view', async () => {
    const views: AppView[] = [];
    const context = createTestContext({ now: NOW, capabilities: { [Contracts.appViews.id]: { register: (view: AppView) => views.push(view) } } });
    await workSkill().setup(context.ctx);
    const board = context.provided.get(Contracts.workInProgress.id) as KvWorkBoard;
    await board.upsert(item({ phase: '테스트 중' }));
    await board.upsert(item({ id: 'browser_x', kind: 'browser', title: '가격 알아보기', status: 'done', summary: '3만 원', updatedAt: minutesAgo(3) }));

    const outcome = await context.ctx.tools.execute('work.status', {});
    const output = outcome.status === 'done' ? (outcome.output as WorkStatusOutput) : undefined;

    expect(output?.active).toMatchObject([{ id: 'dev:job_1', elapsedMinutes: 12, phase: '테스트 중' }]);
    expect(output?.recent).toMatchObject([{ id: 'browser_x', summary: '3만 원' }]);
    expect(output?.message).toBe(
      ['지금 하고 있는 일 1개', '· owner/repo: Fix it: 하는 중 — 테스트 중 (12분째)', '최근에 끝난 일', '· 가격 알아보기: 끝남'].join('\n'),
    );

    await context.bus.emit('app.started', { at: NOW });
    expect(views.map((view) => view.name)).toEqual(['work']);
    const body = await views[0]!.read(new URLSearchParams());
    expect(body).toMatchObject({ title: '하고 있는 일', active: [{ id: 'dev:job_1' }], recent: [{ id: 'browser_x' }] });
  });

  it('says nothing is in progress when the list is empty', async () => {
    const context = createTestContext({ now: NOW });
    await workSkill().setup(context.ctx);
    const outcome = await context.ctx.tools.execute('work.status', {});
    expect(outcome.status === 'done' ? (outcome.output as WorkStatusOutput).message : '').toBe('지금 하고 있는 일은 없어요.');
  });
});

describe('lane', () => {
  it('runs one task at a time in order, and keeps going after a failure', async () => {
    const lane = new Lane();
    const order: string[] = [];
    expect(lane.enqueue(async () => { order.push('a'); throw new Error('boom'); })).toBe(0);
    expect(lane.enqueue(async () => { order.push('b'); })).toBe(1);
    await lane.idle();
    expect(order).toEqual(['a', 'b']);
    expect(lane.ahead).toBe(0);
  });
});
