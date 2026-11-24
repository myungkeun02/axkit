import { describe, expect, it } from 'vitest';
import type { BrowserRunResult, BrowserTask } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { browserSkill } from '../../../src/skills/browser/plugin.js';
import { errandsSkill } from '../../../src/skills/errands/plugin.js';
import type { ErrandOutput } from '../../../src/skills/errands/types.js';
import type { StartedTask, TaskRecord } from '../../../src/skills/work/background.js';
import { KvWorkBoard } from '../../../src/skills/work/board.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { FakeConfirmer, createTestContext } from '../../support/context.js';
import { FakeBrowserAgent, RecordingNotifier, setup } from '../browser/helpers.js';
import { settler } from './settle.js';

const NOW = new Date('2026-11-23T09:00:00+09:00');
const conversation = { channelId: 'channel.app', address: 'owner' };

/** Holds each run until the test lets it go. */
class GatedAgent extends FakeBrowserAgent {
  private releases: (() => void)[] = [];
  started = 0;
  override async run(task: BrowserTask): Promise<BrowserRunResult> {
    this.tasks.push(task);
    this.started += 1;
    await new Promise<void>((resolve) => this.releases.push(resolve));
    return this.result;
  }
  letGo(): void {
    this.releases.shift()?.();
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('browser.task in the background', () => {
  it('answers right away, runs, and reports the result through the notifier', async () => {
    const context = await setup();

    const outcome = await context.ctx.tools.execute('browser.task', { goal: '가격 알아보기', startUrl: 'https://example.com/' });
    const ack = outcome.status === 'done' ? (outcome.output as StartedTask) : undefined;

    expect(ack).toMatchObject({ status: 'running', ahead: 0 });
    expect(ack?.message).toBe(`시작했어요. 끝나면 알려드릴게요. (작업 ${ack?.workId})`);
    await context.settled.next();
    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]).toMatchObject({ kind: 'browser.task', urgent: true });
    expect(context.notifier.notices[0]?.text).toContain("브라우저 심부름 '가격 알아보기'을(를) 마쳤어요.");
    expect(context.notifier.notices[0]?.text).toContain('페이지 내용');
    const stored = (await context.kv.get<TaskRecord[]>('tasks')) ?? [];
    expect(stored[0]).toMatchObject({ id: ack?.workId, status: 'done', link: 'https://example.com/' });
  });

  it('a stop for the owner is a waiting task whose notice carries the guide', async () => {
    const agent = new FakeBrowserAgent();
    agent.result = { status: 'needs_human', summary: '로그인', url: 'https://example.com/login', handoff: { reason: 'login', url: 'https://example.com/login' } };
    const context = await setup({ agent });

    await context.task({ goal: '주문 내역 보기', startUrl: 'https://example.com/' });

    expect(context.notifier.notices[0]?.text).toContain('직접 하실 단계에서 멈췄어요');
    expect(context.notifier.notices[0]?.text).toContain('맥 화면에서 직접 로그인해 주세요');
    expect(((await context.kv.get<TaskRecord[]>('tasks')) ?? [])[0]?.status).toBe('waiting');
  });

  it('answers in English for an English assistant', async () => {
    const context = await setup({ language: 'en' });
    const outcome = await context.ctx.tools.execute('browser.task', { goal: 'check the price' });
    expect(outcome.status === 'done' ? (outcome.output as StartedTask).message : '').toContain("Started. I'll let you know");
    await context.settled.next();
    expect(context.notifier.notices[0]?.text).toContain("Finished the browser errand 'check the price'.");
  });
});

describe('one browser, one queue', () => {
  it('queues an errand behind a browser task on the same browser and says so', async () => {
    const agent = new GatedAgent();
    const notifier = new RecordingNotifier();
    const board = new KvWorkBoard(new MapKeyValueStore(), () => NOW);
    const context = createTestContext({
      now: NOW,
      confirmer: new FakeConfirmer('approved'),
      capabilities: { [Contracts.browser.id]: agent, [Contracts.notifier.id]: notifier, [Contracts.workInProgress.id]: board },
    });
    const settled = settler();
    await browserSkill({ onSettled: settled.onSettled }).setup(context.ctx);
    await errandsSkill({ onSettled: settled.onSettled }).setup(context.ctx);

    const first = await context.ctx.tools.execute('browser.task', { goal: '가격 알아보기' }, { grounding: [], conversation });
    await until(() => agent.started === 1);
    const second = await context.ctx.tools.execute(
      'errands.shop',
      { product: '무선 이어폰', url: 'https://www.coupang.com/vp/products/1' },
      { grounding: [], conversation },
    );
    const ack = second.status === 'done' ? (second.output as StartedTask) : undefined;

    expect(ack).toMatchObject({ status: 'queued', ahead: 1 });
    expect(ack?.message).toContain('지금 하던 일이 1개 있어서 그다음 순서로 해 둘게요');
    expect(agent.started).toBe(1);
    const active = board.split().active;
    expect(active.map((item) => item.status).sort()).toEqual(['queued', 'running']);
    expect(active.find((item) => item.status === 'queued')).toMatchObject({ kind: 'errand', title: '장바구니: 무선 이어폰', origin: conversation });

    agent.letGo();
    await settled.next();
    await until(() => agent.started === 2);
    agent.letGo();
    const errand = await settled.next<ErrandOutput>();
    expect(errand.errand).toBe('shop');
    expect(first.status).toBe('done');
    expect(notifier.notices.map((notice) => notice.kind)).toEqual(['browser.task', 'errands.task']);
    // the cart waits for the owner to pay, so it stays in the list as "waiting"
    expect(board.split().active.map((item) => [item.kind, item.status])).toEqual([['errand', 'waiting']]);
  });
});

describe('after a restart', () => {
  it('marks running and queued tasks interrupted and tells the owner once', async () => {
    const kv = new MapKeyValueStore();
    const at = NOW.toISOString();
    await kv.set('tasks', [
      { id: 'browser_a', kind: 'browser', title: '가격 알아보기', status: 'running', startedAt: at, updatedAt: at },
      { id: 'browser_b', kind: 'browser', title: '영수증 받기', status: 'queued', startedAt: at, updatedAt: at },
      { id: 'browser_c', kind: 'browser', title: '끝난 일', status: 'done', startedAt: at, updatedAt: at },
    ]);
    const notifier = new RecordingNotifier();
    const context = createTestContext({ now: NOW, capabilities: { [Contracts.browser.id]: new FakeBrowserAgent(), [Contracts.notifier.id]: notifier } });
    for (const [key, value] of [['tasks', await kv.get('tasks')]] as const) await context.kv.set(key, value);
    await browserSkill().setup(context.ctx);

    await context.bus.emit('app.started', { at: NOW });
    await context.bus.emit('app.started', { at: NOW });

    expect(notifier.notices.map((notice) => notice.kind)).toEqual(['work.interrupted', 'work.interrupted']);
    expect(notifier.notices[0]?.text).toContain("'가격 알아보기' 작업이 중간에 멈췄어요");
    const stored = (await context.kv.get<TaskRecord[]>('tasks')) ?? [];
    expect(stored.map((item) => [item.id, item.status, item.told])).toEqual([
      ['browser_a', 'interrupted', true],
      ['browser_b', 'interrupted', true],
      ['browser_c', 'done', undefined],
    ]);
  });
});

describe('errands use the assistant language for the handoff guide', () => {
  it('writes the guide in English for an English assistant', async () => {
    const agent = new FakeBrowserAgent();
    agent.result = { status: 'needs_human', summary: 'login', url: 'https://www.letskorail.com/login', handoff: { reason: 'login', url: 'https://www.letskorail.com/login' } };
    const context = createTestContext({
      now: NOW,
      assistant: { language: 'en' },
      confirmer: new FakeConfirmer('approved'),
      capabilities: { [Contracts.browser.id]: agent, [Contracts.notifier.id]: new RecordingNotifier() },
    });
    const settled = settler();
    await errandsSkill({ onSettled: settled.onSettled }).setup(context.ctx);
    await context.ctx.tools.execute('errands.train', { operator: 'ktx', from: '서울', to: '부산', date: '2026-11-28', time: '08:00' });
    const output = await settled.next<ErrandOutput>();
    expect(output.handoff?.guide).toContain('Please sign in yourself');
  });
});
