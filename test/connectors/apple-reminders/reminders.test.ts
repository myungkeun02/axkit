import { describe, expect, it } from 'vitest';
import { AppleReminders, toSyncedTodo } from '../../../src/connectors/apple-reminders/backend.js';
import type { Reminder, RemindersAccess, RemindersClient, ReminderList, ReminderPatch } from '../../../src/connectors/apple-reminders/client.js';
import { HelperRemindersClient, RemindersError } from '../../../src/connectors/apple-reminders/client.js';
import { appleRemindersConnector, remindersCheck } from '../../../src/connectors/apple-reminders/plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { createTestContext } from '../../support/context.js';

const ROW = {
  id: 'r1',
  list: 'L1',
  title: '우유 사기',
  done: false,
  due: '2026-11-20',
  createdAt: '2026-11-17T09:00:00+09:00',
  modifiedAt: '2026-11-17T10:00:00+09:00',
};

function fake(docs: unknown[]) {
  const calls: string[][] = [];
  const queue = [...docs];
  const run: ProcessRunner = async (cmd, args, opts) => {
    calls.push([cmd, ...args, `timeout=${String(opts.timeoutMs)}`]);
    return { code: 0, stdout: JSON.stringify(queue.shift()), stderr: '', timedOut: false };
  };
  return { calls, client: new HelperRemindersClient({ run, helperPath: async () => '/bin/ax-reminders' }) };
}

describe('HelperRemindersClient', () => {
  it('runs every command with its arguments', async () => {
    const { client, calls } = fake([
      { ok: true, status: 'not-determined' },
      { ok: true, granted: true, status: 'authorized' },
      { ok: true, lists: [{ id: 'L1', title: '미리 알림', default: true, writable: true }] },
      { ok: true, reminders: [ROW, { id: 'r2', list: 'L1', title: '끝난 일', done: true, completedAt: '2026-11-16T09:00:00+09:00' }] },
      { ok: true, reminder: ROW },
      { ok: true, reminder: { ...ROW, done: true } },
      { ok: true, reminder: ROW },
      { ok: true, reminder: ROW },
    ]);
    expect(await client.status()).toBe('not-determined');
    expect(await client.request()).toBe(true);
    expect(await client.lists()).toEqual([{ id: 'L1', title: '미리 알림', default: true, writable: true }]);
    const rows = await client.reminders({ list: 'L1', since: new Date('2026-11-01T00:00:00Z'), doneSince: new Date('2026-10-18T00:00:00Z') });
    expect(rows[1]).toEqual({ id: 'r2', list: 'L1', title: '끝난 일', done: true, completedAt: '2026-11-16T09:00:00+09:00' });
    await client.create({ list: 'L1', title: '우유 사기', due: '2026-11-20' });
    expect((await client.complete('r1')).done).toBe(true);
    await client.update('r1', { title: '두유 사기', due: null, done: false });
    await client.update('r1', { due: '2026-11-21T15:00:00+09:00' });
    expect(calls.map((call) => call.slice(1))).toEqual([
      ['status', 'timeout=60000'],
      ['request', 'timeout=150000'],
      ['lists', 'timeout=60000'],
      ['reminders', '--list', 'L1', '--since', '2026-11-01T00:00:00.000Z', '--done-since', '2026-10-18T00:00:00.000Z', 'timeout=60000'],
      ['create', '--title', '우유 사기', '--list', 'L1', '--due', '2026-11-20', 'timeout=60000'],
      ['complete', '--id', 'r1', 'timeout=60000'],
      ['update', '--id', 'r1', '--title', '두유 사기', '--clear-due', '1', '--done', '0', 'timeout=60000'],
      ['update', '--id', 'r1', '--due', '2026-11-21T15:00:00+09:00', 'timeout=60000'],
    ]);
  });

  it('turns a refused permission into the settings hint', async () => {
    const { client } = fake([{ ok: false, error: 'permission', status: 'denied' }]);
    const error = await client.lists().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemindersError);
    expect((error as RemindersError).code).toBe('permission');
    expect((error as Error).message).toContain('개인정보 보호 및 보안 > 미리 알림');
  });

  it('reports missing items and broken documents', async () => {
    expect(await fake([{ ok: false, error: 'not-found' }]).client.complete('x').catch((e: RemindersError) => e.code)).toBe('not-found');
    expect(await fake([{ ok: true, reminders: [{ id: '' }] }]).client.reminders({}).catch((e: RemindersError) => e.code)).toBe('helper');
  });
});

class FakeClient implements RemindersClient {
  access: RemindersAccess = 'authorized';
  grant = true;
  requests = 0;
  listsSeen: ReminderList[] = [
    { id: 'L1', title: '미리 알림', default: true, writable: true },
    { id: 'L2', title: '업무', default: false, writable: true },
  ];
  rows: Reminder[] = [];
  readonly calls: string[] = [];
  async status(): Promise<RemindersAccess> {
    return this.access;
  }
  async request(): Promise<boolean> {
    this.requests += 1;
    if (this.grant) this.access = 'authorized';
    else this.access = 'denied';
    return this.grant;
  }
  async lists(): Promise<ReminderList[]> {
    this.calls.push('lists');
    return this.listsSeen;
  }
  async reminders(opts: { list?: string; doneSince?: Date }): Promise<Reminder[]> {
    this.calls.push(`reminders ${opts.list ?? '-'} ${opts.doneSince?.toISOString() ?? '-'}`);
    return this.rows;
  }
  async create(draft: { list?: string; title: string; due?: string }): Promise<Reminder> {
    this.calls.push(`create ${draft.list ?? '-'} ${draft.title} ${draft.due ?? '-'}`);
    return { id: 'new', list: draft.list ?? '', title: draft.title, done: false, modifiedAt: '2026-11-17T01:00:00Z', ...(draft.due !== undefined ? { due: draft.due } : {}) };
  }
  async complete(id: string): Promise<Reminder> {
    return { ...ROW, id, done: true };
  }
  async update(id: string, patch: ReminderPatch): Promise<Reminder> {
    this.calls.push(`update ${id} ${JSON.stringify(patch)}`);
    return { ...ROW, id, ...(patch.title !== undefined ? { title: patch.title } : {}) };
  }
}

describe('AppleReminders (todo.sync)', () => {
  it('maps reminders to synced to-dos and drops untitled ones', () => {
    expect(toSyncedTodo(ROW)).toEqual({
      id: 'r1',
      text: '우유 사기',
      done: false,
      due: '2026-11-20',
      createdAt: '2026-11-17T09:00:00+09:00',
      updatedAt: '2026-11-17T10:00:00+09:00',
    });
    expect(toSyncedTodo({ ...ROW, title: '  ' })).toBeUndefined();
  });

  it('asks for access once, then uses the default list', async () => {
    const client = new FakeClient();
    client.access = 'not-determined';
    client.rows = [ROW];
    const backend = new AppleReminders(client);
    const since = new Date('2026-10-18T00:00:00Z');
    expect((await backend.list({ completedSince: since })).map((item) => item.id)).toEqual(['r1']);
    await backend.list({});
    expect(client.requests).toBe(1);
    expect(client.calls).toEqual(['lists', `reminders L1 ${since.toISOString()}`, 'reminders L1 -']);
  });

  it('fails with the hint after a refusal and does not ask again', async () => {
    const client = new FakeClient();
    client.access = 'not-determined';
    client.grant = false;
    const backend = new AppleReminders(client);
    await expect(backend.list({})).rejects.toThrow('미리 알림');
    await expect(backend.add({ text: 'x' })).rejects.toThrow('미리 알림');
    expect(client.requests).toBe(1);
  });

  it('uses the named list, keeps only recent done items, and passes patches through', async () => {
    const client = new FakeClient();
    client.rows = [
      ROW,
      { ...ROW, id: 'old', done: true, completedAt: '2026-09-01T00:00:00Z' },
      { ...ROW, id: 'recent', done: true, completedAt: '2026-11-16T00:00:00Z' },
    ];
    const backend = new AppleReminders(client, { listName: '업무' });
    const items = await backend.list({ completedSince: new Date('2026-10-18T00:00:00Z') });
    expect(items.map((item) => item.id)).toEqual(['r1', 'recent']);
    expect((await backend.list({})).map((item) => item.id)).toEqual(['r1']);
    await backend.add({ text: '보고서', due: '2026-11-21' });
    await backend.update('r1', { text: '두유 사기', due: null, done: true });
    expect(client.calls.slice(-2)).toEqual(['create L2 보고서 2026-11-21', 'update r1 {"title":"두유 사기","due":null,"done":true}']);
  });

  it('says so when the named list does not exist', async () => {
    const backend = new AppleReminders(new FakeClient(), { listName: '없는 목록' });
    await expect(backend.list({})).rejects.toThrow("'없는 목록' 목록이 없어요");
  });

  it('is provided as todo.sync by the connector, with the list from config', async () => {
    const client = new FakeClient();
    const context = createTestContext({ config: { list: '업무' } });
    await appleRemindersConnector({ client }).setup(context.ctx);
    const backend = context.ctx.use(Contracts.todoSync);
    await backend.add({ text: 'x' });
    expect(backend.label).toBe('apple-reminders');
    expect(client.calls).toContain('create L2 x -');
  });
});

describe('remindersCheck', () => {
  it.each([
    ['authorized', true, undefined],
    ['not-determined', false, 'allow Reminders'],
    ['denied', false, 'Privacy & Security > Reminders'],
  ] as const)('reports %s', async (status, ok, fix) => {
    const client = new FakeClient();
    client.access = status;
    const check = await remindersCheck(client);
    expect(check.ok).toBe(ok);
    if (fix !== undefined) expect(check.fix).toContain(fix);
    expect(client.requests).toBe(0);
  });
});
