import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openSqliteStore } from '../../../src/core/store/sqlite.js';
import { KILL_MIGRATIONS, SqliteKillSwitch } from '../../../src/core/switches/kill.js';
import { resumeAllTool, stopAllTool } from '../../../src/core/switches/kill-tools.js';
import { PolicyToolExecutor } from '../../../src/core/tools/executor.js';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import type { Tool } from '../../../src/core/tools/types.js';
import type { Effect } from '../../../src/core/policy/types.js';

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
const audit = { append: vi.fn(async () => undefined) };

async function setup() {
  const store = openSqliteStore(':memory:');
  await store.migrate(KILL_MIGRATIONS);
  const kill = new SqliteKillSwitch(store.sql, () => new Date('2026-11-19T00:00:00Z'));
  const registry = new InMemoryToolRegistry();
  const ran: string[] = [];
  const make = (name: string, effects: Effect[]): Tool<object, string> => ({
    name, description: name, input: z.object({}), effects,
    run: async () => { ran.push(name); return 'ok'; },
  });
  registry.register(make('mail.send', ['send']));
  registry.register(make('todo.add', ['write']));
  registry.register(make('web.read', ['read']));
  registry.register(stopAllTool(kill));
  registry.register(resumeAllTool(kill));
  const confirm = vi.fn(async () => 'approved' as const);
  const executor = new PolicyToolExecutor({
    registry, confirmer: () => ({ confirm }), policy: { confirmWrites: false, expiresMinutes: 30 }, audit, log,
    kill: () => kill.state(),
  });
  return { kill, executor, ran, confirm, store };
}

describe('kill switch', () => {
  it('refuses send/pay/delete tools while stopped, before asking, and lets reads and writes run', async () => {
    const { executor, ran, confirm } = await setup();
    await executor.execute('safety.stop_all', { reason: '이상한 메일' });
    expect(await executor.execute('mail.send', {})).toMatchObject({ status: 'rejected' });
    expect(confirm).not.toHaveBeenCalled();
    expect(await executor.execute('todo.add', {})).toMatchObject({ status: 'done' });
    expect(await executor.execute('web.read', {})).toMatchObject({ status: 'done' });
    expect(ran).toEqual(['todo.add', 'web.read']);
  });

  it('resuming always goes through a confirmation card', async () => {
    const { executor, ran, confirm, kill } = await setup();
    await kill.stop('x', 'cli');
    expect(await executor.execute('safety.resume_all', {})).toMatchObject({ status: 'done' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await executor.execute('mail.send', {})).toMatchObject({ status: 'done' });
    expect(ran).toEqual(['mail.send']);
  });

  it('catches a stop pressed while the card was waiting', async () => {
    const { executor, ran, kill, confirm } = await setup();
    confirm.mockImplementationOnce(async () => {
      await kill.stop('late', 'owner');
      return 'approved';
    });
    expect(await executor.execute('mail.send', {})).toMatchObject({ status: 'rejected' });
    expect(ran).toEqual([]);
  });

  it('fails closed when the flag cannot be read', async () => {
    const { executor, store } = await setup();
    store.sql.exec('DROP TABLE kill_switch');
    expect(await executor.execute('mail.send', {})).toMatchObject({ status: 'rejected' });
  });
});
