import { describe, expect, it } from 'vitest';
import { liveHandoffOf } from '../../../src/skills/assistant/live.js';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { InMemoryEventBus } from '../../../src/core/events/bus.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { SqliteWorkLog, WORK_LOG_MIGRATIONS } from '../../../src/core/log/work-log.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import { openSqliteStore } from '../../../src/core/store/sqlite.js';
import type { Toolbox } from '../../../src/core/tools/types.js';
import { delegateTool, rosterSection, withoutDelegation } from '../../../src/skills/assistant/bots.js';

async function setup() {
  const store = openSqliteStore(':memory:');
  await store.migrate(WORK_LOG_MIGRATIONS);
  const bots = new KvBotDirectory(store.kv('bots'), () => new Date('2026-11-19T00:00:00Z'));
  const work = new SqliteWorkLog(store.sql);
  const bus = new InMemoryEventBus(silentLogger);
  const seen: string[] = [];
  bus.on('bots.delegation', (event) => void seen.push(`${event.state}:${event.task}`));
  bus.on('bots.message', (event) => void seen.push(`message:${event.text}`));
  const ctx = {
    bus,
    clock: { now: () => new Date('2026-11-19T01:00:00Z') },
    tryUse: (cap: unknown) => (cap === Contracts.workLog ? work : undefined),
  } as unknown as PluginContext;
  await bots.upsert({ id: 'dev', name: '개발 봇', role: '코드를 고쳐요', kind: 'dev', origin: 'owner' });
  return { bots, work, ctx, seen };
}

describe('bots.delegate', () => {
  it('runs the bot in its room, reports start and end, and logs the work', async () => {
    const { bots, work, ctx, seen } = await setup();
    let statusDuring = '';
    const tool = delegateTool({
      ctx,
      bots,
      runBotTurn: async (bot, message) => {
        statusDuring = (await bots.get(bot.id))?.status ?? '';
        expect(message.conversation.address).toBe('bot:dev');
        return { text: '글꼴 로딩 문제였어요. 고쳤어요.' };
      },
    });
    const out = await tool.run({ bot: 'dev', task: '로그인 화면 고치기' }, { log: silentLogger, signal: new AbortController().signal, call: { grounding: [] } });
    expect(out).toEqual({ bot: '개발 봇', summary: '글꼴 로딩 문제였어요. 고쳤어요.' });
    expect(statusDuring).toBe('working');
    expect((await bots.get('dev'))?.status).toBe('idle');
    expect(seen).toEqual(['started:로그인 화면 고치기', 'message:글꼴 로딩 문제였어요. 고쳤어요.', 'done:로그인 화면 고치기']);
    const logged = await work.between(new Date('2026-11-18T00:00:00Z'), new Date('2026-11-20T00:00:00Z'));
    expect(logged).toMatchObject([{ title: '로그인 화면 고치기', kind: 'delegation', bot: { id: 'dev', name: '개발 봇' } }]);
  });

  it('passes a page the bot left for the owner up the way browser outputs do (§22)', async () => {
    const { bots, ctx } = await setup();
    const tool = delegateTool({ ctx, bots, runBotTurn: async () => ({ text: '로그인에서 멈췄어요.', live: { view: 'browser-live', reason: 'login', url: 'https://shop.example.com/login' } }) });
    const out = await tool.run({ bot: 'dev', task: '주문 내역' }, { log: silentLogger, signal: new AbortController().signal, call: { grounding: [] } });
    expect(out).toEqual({ bot: '개발 봇', summary: '로그인에서 멈췄어요.', liveView: 'browser-live', handoff: { reason: 'login' }, url: 'https://shop.example.com/login' });
    expect(liveHandoffOf(out)).toEqual({ view: 'browser-live', reason: 'login', url: 'https://shop.example.com/login' });
  });

  it('reports a failure and refuses unknown or switched-off bots', async () => {
    const { bots, ctx, seen } = await setup();
    const tool = delegateTool({ ctx, bots, runBotTurn: async () => { throw new Error('boom'); } });
    const run = (bot: string) => tool.run({ bot, task: 't' }, { log: silentLogger, signal: new AbortController().signal, call: { grounding: [] } });
    await expect(run('dev')).rejects.toThrow('boom');
    expect(seen.at(-1)).toBe('failed:t');
    expect((await bots.get('dev'))?.status).toBe('idle');
    await expect(run('ghost')).rejects.toThrow('No active bot');
    await bots.setStatus('dev', 'off');
    await expect(run('dev')).rejects.toThrow('No active bot');
  });

  it('a bot turn cannot delegate again, and the main prompt lists active bots', async () => {
    const inner: Toolbox = {
      list: () => [{ name: 'bots.delegate', description: '', effects: ['write'], inputSchema: {} }, { name: 'todo.add', description: '', effects: ['write'], inputSchema: {} }],
      execute: async () => ({ status: 'done', output: 'ran' }),
    };
    const wrapped = withoutDelegation(inner);
    expect(wrapped.list().map((tool) => tool.name)).toEqual(['todo.add']);
    expect(await wrapped.execute('bots.delegate', {})).toMatchObject({ status: 'rejected' });
    expect(await wrapped.execute('todo.add', {})).toMatchObject({ status: 'done' });
    const { bots } = await setup();
    expect(rosterSection(await bots.list(), true)).toContain('dev (개발 봇): 코드를 고쳐요');
    expect(rosterSection([], true)).toBeUndefined();
  });
});
