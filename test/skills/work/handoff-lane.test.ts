import { describe, expect, it } from 'vitest';
import type { BrowserRunResult, BrowserTask, LiveBrowser, LiveFrame } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { PENDING_MS } from '../../../src/skills/browser/live-hub.js';
import { browserSkill } from '../../../src/skills/browser/plugin.js';
import type { StartedTask, TaskRecord } from '../../../src/skills/work/background.js';
import { flush } from '../../core/helpers.js';
import { FakeConfirmer, createTestContext } from '../../support/context.js';
import { FakeBrowserAgent, RecordingNotifier } from '../browser/helpers.js';
import { settler } from './settle.js';

const NOW = new Date('2026-11-23T09:00:00+09:00');
const conversation = { channelId: 'channel.app', address: 'owner' };
const LOGIN: BrowserRunResult = {
  status: 'needs_human',
  summary: '로그인',
  url: 'https://example.com/login',
  handoff: { reason: 'login', url: 'https://example.com/login' },
};

class StillPage implements LiveBrowser {
  async frame(): Promise<LiveFrame> {
    return { jpeg: Buffer.from([0xff, 0xd8, 0xff]), width: 800, height: 1600, url: 'https://example.com/login', title: '' };
  }
  async tap(): Promise<void> {}
  async type(): Promise<void> {}
  async key(): Promise<void> {}
  async scroll(): Promise<void> {}
  async back(): Promise<void> {}
  async close(): Promise<void> {}
}

/** A browser that keeps the handoff page; a second run would release it (what the real adapter does). */
class KeepingAgent extends FakeBrowserAgent {
  results: BrowserRunResult[] = [];
  released = 0;
  override async run(task: BrowserTask): Promise<BrowserRunResult> {
    this.tasks.push(task);
    return this.results.shift() ?? this.result;
  }
  async releaseKept(): Promise<void> {
    this.released += 1;
  }
  async openLive(): Promise<LiveBrowser> {
    return new StillPage();
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function setupKeeping() {
  const agent = new KeepingAgent();
  agent.results = [LOGIN];
  const notifier = new RecordingNotifier();
  const context = createTestContext({
    now: NOW,
    confirmer: new FakeConfirmer('approved'),
    capabilities: {
      [Contracts.browser.id]: agent,
      [Contracts.notifier.id]: notifier,
      [Contracts.appViews.id]: { register: () => undefined },
    },
  });
  const settled = settler();
  await browserSkill({ onSettled: settled.onSettled }).setup(context.ctx);
  const start = async (goal: string): Promise<StartedTask> => {
    const outcome = await context.ctx.tools.execute('browser.task', { goal, startUrl: 'https://example.com/' }, { grounding: [], conversation });
    if (outcome.status !== 'done') throw new Error(`browser.task: ${outcome.status}`);
    return outcome.output as StartedTask;
  };
  const records = async (): Promise<TaskRecord[]> => (await context.kv.get<TaskRecord[]>('tasks')) ?? [];
  return { agent, notifier, context, settled, start, records };
}

describe('a browser handoff keeps the browser', () => {
  it('holds queued work until the owner finishes the handoff, and says why it waits', async () => {
    const { agent, notifier, context, settled, start, records } = await setupKeeping();
    const first = await start('주문 내역 보기');
    await settled.next();
    expect(notifier.notices[0]?.live).toMatchObject({ view: 'browser-live', reason: 'login' });

    const second = await start('가격 알아보기');
    expect(second.status).toBe('queued');
    expect(second.message).toContain('직접 하시는 걸 기다리고 있어서');
    await flush();
    await flush();
    expect(agent.tasks).toHaveLength(1);
    expect(agent.released).toBe(0);

    await context.ctx.use(Contracts.browserLive).finish();
    await until(() => agent.tasks.length === 2);
    expect(agent.tasks).toHaveLength(2);
    await settled.next();
    expect((await records()).find((item) => item.id === first.workId)?.status).toBe('done');
    expect((await records()).find((item) => item.id === second.workId)?.status).toBe('done');
  });

  it('frees the browser when the handoff expires unopened', async () => {
    const { agent, context, settled, start, records } = await setupKeeping();
    const first = await start('주문 내역 보기');
    await settled.next();
    await start('가격 알아보기');
    await flush();
    expect(agent.tasks).toHaveLength(1);

    await context.clock.advance(PENDING_MS + 60_000);
    await until(() => agent.tasks.length === 2);
    expect(agent.tasks).toHaveLength(2);
    await settled.next();
    expect((await records()).find((item) => item.id === first.workId)?.status).toBe('failed');
  });
});

describe('shutdown', () => {
  it('keeps a task whose adapter resolves on abort interrupted, with no failure notice', async () => {
    class ResolvingOnAbort extends FakeBrowserAgent {
      override run(_task: BrowserTask, signal?: AbortSignal): Promise<BrowserRunResult> {
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ status: 'failed', summary: 'aborted' }));
        });
      }
    }
    const notifier = new RecordingNotifier();
    const context = createTestContext({
      now: NOW,
      capabilities: { [Contracts.browser.id]: new ResolvingOnAbort(), [Contracts.notifier.id]: notifier },
    });
    await browserSkill().setup(context.ctx);
    await context.ctx.tools.execute('browser.task', { goal: '가격 알아보기' }, { grounding: [], conversation });
    await flush();

    await context.bus.emit('app.stopping', { reason: 'test' });
    for (let i = 0; i < 5; i += 1) await flush();

    expect(notifier.notices).toHaveLength(0);
    const stored = (await context.kv.get<TaskRecord[]>('tasks')) ?? [];
    expect(stored[0]?.status).toBe('running');
  });
});

describe('record cap', () => {
  it('evicts only finished records, never running or queued ones', async () => {
    class Gated extends FakeBrowserAgent {
      private releases: (() => void)[] = [];
      override async run(task: BrowserTask): Promise<BrowserRunResult> {
        this.tasks.push(task);
        await new Promise<void>((resolve) => this.releases.push(resolve));
        return this.result;
      }
      letGo(): void {
        this.releases.shift()?.();
      }
    }
    const agent = new Gated();
    const context = createTestContext({
      now: NOW,
      capabilities: { [Contracts.browser.id]: agent, [Contracts.notifier.id]: new RecordingNotifier() },
    });
    const at = NOW.toISOString();
    // oldest last: 28 finished records and, at the very end, one still waiting for the owner
    await context.kv.set('tasks', [
      ...Array.from({ length: 28 }, (_, i) => ({ id: `browser_old${i}`, kind: 'browser', title: `옛일 ${i}`, status: 'done', startedAt: at, updatedAt: at })),
      { id: 'browser_waiting', kind: 'browser', title: '결제 기다림', status: 'waiting', startedAt: at, updatedAt: at },
    ]);
    const settled = settler();
    await browserSkill({ onSettled: settled.onSettled }).setup(context.ctx);
    const ids: string[] = [];
    for (const goal of ['하나', '둘', '셋']) {
      const outcome = await context.ctx.tools.execute('browser.task', { goal }, { grounding: [], conversation });
      ids.push((outcome.status === 'done' ? (outcome.output as StartedTask) : undefined)?.workId ?? '');
    }
    const stored = (await context.kv.get<TaskRecord[]>('tasks')) ?? [];
    expect(stored).toHaveLength(30);
    expect(ids.every((id) => stored.some((item) => item.id === id))).toBe(true);
    expect(stored.some((item) => item.id === 'browser_waiting')).toBe(true);
    expect(stored.some((item) => item.id === 'browser_old27' || item.id === 'browser_old26')).toBe(false);

    for (let i = 0; i < 3; i += 1) {
      await until(() => agent.tasks.length === i + 1);
      agent.letGo();
      await settled.next();
    }
    const after = (await context.kv.get<TaskRecord[]>('tasks')) ?? [];
    expect(ids.map((id) => after.find((item) => item.id === id)?.status)).toEqual(['done', 'done', 'done']);
  });

  it('refuses new work with a clear message once too much is waiting', async () => {
    class Never extends FakeBrowserAgent {
      override run(): Promise<BrowserRunResult> {
        return new Promise(() => undefined);
      }
    }
    const context = createTestContext({
      now: NOW,
      capabilities: { [Contracts.browser.id]: new Never(), [Contracts.notifier.id]: new RecordingNotifier() },
    });
    await browserSkill().setup(context.ctx);
    let last: Awaited<ReturnType<typeof context.ctx.tools.execute>> | undefined;
    for (let i = 0; i < 31; i += 1) last = await context.ctx.tools.execute('browser.task', { goal: `일 ${i}` }, { grounding: [], conversation });
    expect(last?.status).toBe('failed');
    expect(last?.status === 'failed' ? last.error : '').toContain('밀려 있어서');
    const stored = (await context.kv.get<TaskRecord[]>('tasks')) ?? [];
    expect(stored.every((item) => item.status === 'running' || item.status === 'queued')).toBe(true);
  });
});
