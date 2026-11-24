import { describe, expect, it } from 'vitest';
import { MapKeyValueStore } from '../../core/helpers.js';
import { reapTasks } from '../../../src/skills/company/reaper.js';
import { KvTaskRepository } from '../../../src/skills/company/store.js';
import { companyConfig, DAY_MS, HOUR_MS, NOW, task } from './helpers.js';

async function seededRepo(tasks: ReturnType<typeof task>[]): Promise<KvTaskRepository> {
  const kv = new MapKeyValueStore();
  await kv.set('tasks', tasks);
  return new KvTaskRepository(kv, () => NOW);
}

describe('reapTasks', () => {
  it('closes stale work and expired owner waits with their reasons', async () => {
    const repo = await seededRepo([
      task({ id: 'aaaaaaaa', status: 'running', updatedAt: new Date(NOW.getTime() - 73 * HOUR_MS).toISOString() }),
      task({
        id: 'bbbbbbbb',
        status: 'awaiting_owner',
        updatedAt: new Date(NOW.getTime() - 8 * DAY_MS).toISOString(),
      }),
      task({
        id: 'cccccccc',
        status: 'awaiting_accept',
        updatedAt: new Date(NOW.getTime() - 8 * DAY_MS).toISOString(),
      }),
      task({ id: 'dddddddd', status: 'queued', updatedAt: new Date(NOW.getTime() - HOUR_MS).toISOString() }),
      task({
        id: 'eeeeeeee',
        status: 'done',
        updatedAt: new Date(NOW.getTime() - 200 * HOUR_MS).toISOString(),
        finishedAt: new Date(NOW.getTime() - 200 * HOUR_MS).toISOString(),
      }),
    ]);

    const closed = await reapTasks(repo, companyConfig().limits, NOW);

    expect(closed.map((item) => item.id).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    expect(closed.find((item) => item.id === 'aaaaaaaa')).toMatchObject({
      status: 'closed',
      closedReason: 'stale',
      finishedAt: NOW.toISOString(),
    });
    expect(closed.find((item) => item.id === 'bbbbbbbb')?.closedReason).toBe('owner_wait_expired');
    expect(closed.find((item) => item.id === 'cccccccc')?.closedReason).toBe('owner_wait_expired');
    expect((await repo.get('dddddddd'))?.status).toBe('queued');
    expect((await repo.get('eeeeeeee'))?.status).toBe('done');
  });

  it('keeps a task that is exactly at the age limit', async () => {
    const repo = await seededRepo([
      task({ id: 'aaaaaaaa', status: 'running', updatedAt: new Date(NOW.getTime() - 72 * HOUR_MS).toISOString() }),
      task({
        id: 'bbbbbbbb',
        status: 'awaiting_owner',
        updatedAt: new Date(NOW.getTime() - 7 * DAY_MS).toISOString(),
      }),
    ]);

    expect(await reapTasks(repo, companyConfig().limits, NOW)).toEqual([]);
  });

  it('returns nothing when there is no open work', async () => {
    const repo = await seededRepo([task({ id: 'aaaaaaaa', status: 'done' })]);

    expect(await reapTasks(repo, companyConfig().limits, NOW)).toEqual([]);
  });
});
