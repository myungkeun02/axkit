import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConfirmAnswer, ConfirmRequest, Confirmer, Effect } from '../../../src/core/policy/types.js';
import { MemoryAuditLog, silentLogger } from '../../../src/core/log/console-logger.js';
import { InMemoryToolRegistry } from '../../../src/core/tools/registry.js';
import { PolicyToolExecutor } from '../../../src/core/tools/executor.js';
import { openSqliteStore } from '../../../src/core/store/sqlite.js';
import { AUTONOMY_MIGRATIONS, SqliteAutonomyRules } from '../../../src/core/policy/autonomy.js';
import type { AutonomyScope } from '../../../src/core/policy/autonomy.js';
import { PROMOTION_MIGRATIONS, SqliteScopeTracks, promotionVerdict } from '../../../src/core/policy/promotion.js';
import type { ScopeTrack } from '../../../src/core/policy/promotion.js';
import { AutonomyPromoter } from '../../../src/core/policy/promoter.js';
import { autonomyCorrectTool } from '../../../src/core/policy/promotion-tool.js';
import { OwnerQuestions } from '../../../src/core/policy/questions.js';
import { SqliteTopicAnswers, TOPIC_MIGRATIONS } from '../../../src/core/policy/topics.js';

/** Tool cards: answers from `next` (default yes). Promotion questions: the choice in `offer`. */
class FakeCards implements Confirmer {
  readonly cards: ConfirmRequest[] = [];
  readonly offers: ConfirmRequest[] = [];
  next: (ConfirmAnswer | 'typed')[] = [];
  offer = 'yes';
  async confirm(request: ConfirmRequest): Promise<ConfirmAnswer> {
    if (request.topic?.startsWith('autonomy:promote:') === true) {
      this.offers.push(request);
      const choice = request.choices?.find((c) => c.id === this.offer);
      request.report?.({ choice: this.offer });
      return choice?.means === 'approved' ? 'approved' : 'denied';
    }
    this.cards.push(request);
    const answer = this.next.shift() ?? 'approved';
    if (answer === 'typed') {
      request.report?.({ text: '다르게 해 줘' });
      return 'denied';
    }
    return answer;
  }
}

interface ToolSpec {
  effects?: Effect[];
  scope?: (to: string) => AutonomyScope | undefined;
  uncertain?: boolean;
}

async function setup(spec: ToolSpec = {}) {
  const store = openSqliteStore(':memory:');
  await store.migrate([...AUTONOMY_MIGRATIONS, ...TOPIC_MIGRATIONS, ...PROMOTION_MIGRATIONS]);
  const now = (): Date => new Date('2026-11-23T09:00:00Z');
  const rules = new SqliteAutonomyRules(store.sql, now);
  const cards = new FakeCards();
  const questions = new OwnerQuestions({ topics: new SqliteTopicAnswers(store.sql, now), confirmer: () => cards, now });
  const notices: string[] = [];
  const audit = new MemoryAuditLog();
  const promoter = new AutonomyPromoter({ tracks: new SqliteScopeTracks(store.sql, now), rules, questions: () => questions, notify: (text) => notices.push(text), audit, log: silentLogger, language: 'ko' });
  const state = { fail: false };
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: 'test.act',
    description: 'act',
    input: z.object({ to: z.string() }),
    effects: spec.effects ?? ['send'],
    describe: (input: { to: string }) => `${input.to}에게 인사 보내기`,
    ...(spec.scope !== undefined ? { autonomyScope: (input: { to: string }) => spec.scope?.(input.to) } : {}),
    ...(spec.uncertain === true ? { uncertainty: () => '날짜가 확실하지 않아요' } : {}),
    run: () => (state.fail ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true })),
  });
  registry.register(autonomyCorrectTool(promoter));
  const executor = new PolicyToolExecutor({
    registry,
    confirmer: () => cards,
    policy: { confirmWrites: true, expiresMinutes: 30 },
    audit,
    log: silentLogger,
    autonomy: rules,
    tracker: promoter,
    rememberLabel: (summary) => `앞으로 같은 일("${summary}")은 묻지 않고 할게요`,
    onAuto: (_rule, summary) => notices.push(`알아서 했어요: ${summary}`),
  });
  const run = async (times: number, to = '민수'): Promise<void> => {
    for (let i = 0; i < times; i += 1) await executor.execute('test.act', { to });
    await promoter.settled();
  };
  return { executor, cards, notices, rules, run, state, promoter, audit };
}

describe('자동 실행 승격', () => {
  it('offers once after 20 clean approvals; yes makes a promoted rule that runs on its own and reports', async () => {
    const h = await setup();
    await h.run(19);
    expect(h.cards.offers).toHaveLength(0);
    await h.run(1);
    expect(h.cards.offers).toHaveLength(1);
    expect(h.cards.offers[0]?.summary).toBe('이 일은 지난 20번 모두 승인하셨어요. 앞으로는 알아서 하고 결과만 알려 드릴까요?');
    expect(h.cards.offers[0]?.choices?.map((c) => c.id)).toEqual(['yes', 'later', 'never']);
    const [rule] = await h.rules.list();
    expect(rule).toMatchObject({ origin: 'promoted', uses: 0 });

    expect(await h.executor.execute('test.act', { to: '민수' })).toMatchObject({ status: 'done' });
    expect(h.cards.cards).toHaveLength(20);
    expect(h.notices).toEqual(['알아서 했어요: 민수에게 인사 보내기']);
    await h.run(5);
    expect(h.cards.offers).toHaveLength(1);
    // another recipient is another scope
    await h.run(1, '지수');
    expect(h.cards.cards).toHaveLength(21);
  });

  it('needs ≥95% clean and no no in the last 10', async () => {
    const low = await setup();
    low.cards.next = ['denied', 'denied'];
    await low.run(22); // 20 of 22 = 91%
    expect(low.cards.offers).toHaveLength(0);

    const recent = await setup();
    recent.cards.next = [...Array<ConfirmAnswer>(15).fill('approved'), 'typed'];
    await recent.run(21); // 20 of 21 = 95.2%, but the typed change is in the last 10
    expect(recent.cards.offers).toHaveLength(0);
    await recent.run(4);
    expect(recent.cards.offers).toHaveLength(0);
    await recent.run(1); // the change has left the last 10
    expect(recent.cards.offers).toHaveLength(1);
    expect(recent.cards.offers[0]?.summary).toContain('지난 26번 중 25번');
  });

  it('a failed run does not count as a clean approval', async () => {
    const h = await setup();
    await h.run(10);
    h.state.fail = true;
    await h.run(1);
    h.state.fail = false;
    await h.run(9);
    expect(h.cards.offers).toHaveLength(0); // 19 clean of 20
    await h.run(1);
    expect(h.cards.offers).toHaveLength(1);
  });

  it('never offers pay, delete, guessed inputs or sends to an unnamed recipient', async () => {
    const own = (to: string): AutonomyScope => ({ key: `to|${to}`, label: `${to}에게 5만 원까지` });
    for (const effects of [['pay'], ['delete']] as Effect[][]) {
      const h = await setup({ effects, scope: own });
      await h.run(25);
      expect(h.cards.offers).toHaveLength(0);
    }
    const guessed = await setup({ effects: ['write'], uncertain: true });
    await guessed.run(25);
    expect(guessed.cards.offers).toHaveLength(0);

    const unnamed = await setup({ effects: ['send'], scope: own });
    await unnamed.run(25);
    expect(unnamed.cards.offers).toHaveLength(0);
    const named = await setup({ effects: ['send'], scope: (to) => ({ ...own(to), recipient: to }) });
    await named.run(20);
    expect(named.cards.offers).toHaveLength(1);
  });

  it('a send recipient seen fewer than 3 times blocks promotion', () => {
    const track: ScopeTrack = { tool: 't', scope: 'to|a', label: 'a', recipient: 'a', effects: ['send'], approved: 20, denied: 0, edited: 0, failed: 0, corrected: 0, recent: 'aaaaaaaaaa', askState: 'none', askAfter: 0, autoFails: 0 };
    expect(promotionVerdict(track, { recipientSeen: 2 })).toEqual({ ok: false, reason: 'recipient' });
    expect(promotionVerdict(track, { recipientSeen: 3 })).toEqual({ ok: true, clean: 20, total: 20 });
    expect(promotionVerdict({ ...track, effects: ['write'] }, { uncertain: true })).toEqual({ ok: false, reason: 'uncertain' });
    expect(promotionVerdict({ ...track, approved: 19 }, { recipientSeen: 9 })).toEqual({ ok: false, reason: 'too_few' });
  });

  it('not now asks again only after 30 more approvals; never is final', async () => {
    const later = await setup();
    later.cards.offer = 'later';
    await later.run(20);
    expect(later.cards.offers).toHaveLength(1);
    await later.run(29);
    expect(later.cards.offers).toHaveLength(1);
    await later.run(1);
    expect(later.cards.offers).toHaveLength(2);
    expect(await later.rules.list()).toHaveLength(0);

    const never = await setup();
    never.cards.offer = 'never';
    await never.run(80);
    expect(never.cards.offers).toHaveLength(1);
    expect(await never.rules.list()).toHaveLength(0);
  });

  it('a promoted rule that fails twice in a row pauses, tells once, and cards come back', async () => {
    const h = await setup();
    await h.run(20);
    h.state.fail = true;
    await h.run(1);
    expect((await h.rules.list())[0]?.paused).toBeUndefined();
    await h.run(1);
    const [rule] = await h.rules.list();
    expect(rule?.paused).toBeDefined();
    expect(h.notices.filter((text) => text.includes('알아서 하던 일을 멈췄어요'))).toHaveLength(1);
    expect(h.notices.some((text) => text.includes('연달아 두 번 실패했어요'))).toBe(true);
    h.state.fail = false;
    await h.run(30);
    expect(h.cards.cards).toHaveLength(50);
    expect(h.cards.offers).toHaveLength(1);
    // turned back on in the view, it runs on its own again
    expect(await h.rules.resume(rule?.id ?? '')).toBe(true);
    await h.run(1);
    expect(h.cards.cards).toHaveLength(50);
  });

  it('a success in between resets the failure count', async () => {
    const h = await setup();
    await h.run(20);
    for (const fail of [true, false, true, false]) {
      h.state.fail = fail;
      await h.run(1);
    }
    expect((await h.rules.list())[0]?.paused).toBeUndefined();
  });

  it('the owner correcting a promoted action pauses the rule once', async () => {
    const h = await setup();
    await h.run(20);
    await h.run(1);
    expect(await h.executor.execute('autonomy.correct', { tool: 'test.act' })).toMatchObject({ status: 'done', output: { status: 'ok', paused: true } });
    expect(h.promoter.counts((await h.rules.list())[0]!)).toMatchObject({ approved: 19, corrected: 1 });
    expect(await h.executor.execute('autonomy.correct', { tool: 'test.act' })).toMatchObject({ output: { paused: false } });
    expect(h.notices.filter((text) => text.includes('바로잡아 달라고 하셔서요'))).toHaveLength(1);
    expect(await h.executor.execute('autonomy.correct', { tool: 'nothing.here' })).toMatchObject({ output: { status: 'not_found' } });
  });

  it('a card rule ("from now on") stops further offers', async () => {
    const h = await setup();
    h.cards.next = [];
    const first = h.executor.execute('test.act', { to: '민수' });
    await first;
    const remember = h.cards.cards[0]?.remember;
    await remember?.accept();
    await h.run(25);
    expect(h.cards.offers).toHaveLength(0);
    expect((await h.rules.list())[0]?.origin).toBe('card');
  });
});
