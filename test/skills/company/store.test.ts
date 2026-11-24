import { describe, expect, it } from 'vitest';
import { MapKeyValueStore } from '../../core/helpers.js';
import { KvTaskRepository, recordApproval } from '../../../src/skills/company/store.js';
import { NOW, task } from './helpers.js';

const AT = NOW.toISOString();

function repoAt(now: () => Date = () => NOW): { repo: KvTaskRepository; kv: MapKeyValueStore } {
  const kv = new MapKeyValueStore();
  return { repo: new KvTaskRepository(kv, now), kv };
}

describe('KvTaskRepository', () => {
  it('creates a task with an eight-hex id and empty progress fields', async () => {
    const { repo } = repoAt();

    const created = await repo.create({
      team: 'dev',
      title: '  로그인 고치기  ',
      request: '  로그인 버그를 고쳐 주세요  ',
      source: 'owner',
      status: 'queued',
    });

    expect(created.id).toMatch(/^[a-f0-9]{8}$/);
    expect(created).toMatchObject({
      team: 'dev',
      title: '로그인 고치기',
      request: '로그인 버그를 고쳐 주세요',
      source: 'owner',
      status: 'queued',
      steps: [],
      ownerEffects: [],
      revisions: 0,
      approvals: [],
      createdAt: AT,
      updatedAt: AT,
    });
    expect(created.sourceRef).toBeUndefined();
    expect(created.finishedAt).toBeUndefined();
  });

  it('clips the request to 2000 characters and the title to 120', async () => {
    const { repo } = repoAt();

    const created = await repo.create({
      team: 'dev',
      title: 'x'.repeat(200),
      request: 'y'.repeat(3000),
      source: 'owner',
      status: 'queued',
    });

    expect(created.title).toHaveLength(120);
    expect(created.request).toHaveLength(2000);
  });

  it('drops malformed entries on read', async () => {
    const { repo, kv } = repoAt();
    const valid = task({ id: 'aaaaaaaa' });
    await kv.set('tasks', [valid, 'not a task', { id: 'zzzzzzzz' }, { ...valid, id: 'bbbbbbbb', status: 'weird' }]);

    const all = await repo.all();

    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('aaaaaaaa');
  });

  it('returns undefined for an unknown id and bumps updatedAt on update', async () => {
    let current = NOW;
    const { repo } = repoAt(() => current);
    const created = await repo.create({ team: 'dev', title: '일', request: '일', source: 'owner', status: 'queued' });
    current = new Date(NOW.getTime() + 60_000);

    expect(await repo.update('deadbeef', (existing) => existing)).toBeUndefined();
    const updated = await repo.update(created.id, (existing) => ({ ...existing, status: 'running' }));

    expect(updated?.updatedAt).toBe(current.toISOString());
    expect(updated?.finishedAt).toBeUndefined();
  });

  it('sets finishedAt once when a task reaches a final status', async () => {
    let current = NOW;
    const { repo } = repoAt(() => current);
    const created = await repo.create({ team: 'dev', title: '일', request: '일', source: 'owner', status: 'running' });
    current = new Date(NOW.getTime() + 60_000);

    const done = await repo.update(created.id, (existing) => ({ ...existing, status: 'done' }));
    current = new Date(NOW.getTime() + 120_000);
    const again = await repo.update(created.id, (existing) => ({ ...existing, result: '끝' }));

    expect(done?.finishedAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(again?.finishedAt).toBe(done?.finishedAt);
  });

  it('open() returns every non-final status, including awaiting_accept', async () => {
    const { repo, kv } = repoAt();
    await kv.set('tasks', [
      task({ id: 'aaaaaaaa', status: 'awaiting_accept' }),
      task({ id: 'bbbbbbbb', status: 'review' }),
      task({ id: 'cccccccc', status: 'done' }),
      task({ id: 'dddddddd', status: 'closed' }),
    ]);

    expect((await repo.open()).map((item) => item.id)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  it('caps the store at 500 by dropping the oldest finished task, never an open one', async () => {
    const { repo, kv } = repoAt();
    const seeded: ReturnType<typeof task>[] = [];
    for (let index = 0; index < 499; index += 1) {
      seeded.push(
        task({
          id: index.toString(16).padStart(8, '0'),
          status: 'done',
          createdAt: new Date(NOW.getTime() - (1000 - index) * 1000).toISOString(),
        }),
      );
    }
    seeded.push(task({ id: 'ffffffff', status: 'running' }));
    await kv.set('tasks', seeded);

    await repo.create({ team: 'dev', title: '새 일', request: '새 일', source: 'owner', status: 'queued' });

    const all = await repo.all();
    expect(all).toHaveLength(500);
    expect(all.some((item) => item.id === '00000000')).toBe(false);
    expect(all.some((item) => item.id === 'ffffffff')).toBe(true);
  });

  it('never drops open work even when every slot is open', async () => {
    const { repo, kv } = repoAt();
    const seeded = Array.from({ length: 500 }, (_, index) =>
      task({ id: index.toString(16).padStart(8, '0'), status: 'running' }),
    );
    await kv.set('tasks', seeded);

    await repo.create({ team: 'dev', title: '새 일', request: '새 일', source: 'owner', status: 'queued' });

    expect(await repo.all()).toHaveLength(501);
  });
});

describe('recordApproval', () => {
  const base = task({ id: 'aaaaaaaa' });

  it('throws when an agent approves send, pay or delete', () => {
    expect(() =>
      recordApproval(base, {
        approverKind: 'agent',
        approverId: 'lead:dev',
        effects: ['send'],
        at: AT,
      }),
    ).toThrow('Only the owner can approve send, pay or delete');
  });

  it('passes the owner approving a send', () => {
    const approved = recordApproval(base, {
      approverKind: 'user',
      approverId: 'owner',
      effects: ['send'],
      at: AT,
    });

    expect(approved.approvals).toHaveLength(1);
    expect(approved.approvals[0]?.approverKind).toBe('user');
  });

  it('passes an agent approving a write', () => {
    const approved = recordApproval(base, {
      approverKind: 'agent',
      approverId: 'lead:dev',
      effects: ['write'],
      at: AT,
    });

    expect(approved.approvals[0]?.approverId).toBe('lead:dev');
  });
});
