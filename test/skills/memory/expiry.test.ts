import { describe, expect, it } from 'vitest';
import type {
  Fact,
  FactExpired,
  HealthCheck,
  HealthFinding,
  HealthRegistry,
  Notice,
  NoticeResult,
  Notifier,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type {
  ConversationRef,
  IncomingMessage,
  OutgoingMessage,
  Replier,
} from '../../../src/core/conversation/types.js';
import { isTimeLimited } from '../../../src/skills/memory/expiry.js';
import { FactStore } from '../../../src/skills/memory/facts.js';
import { memorySkill } from '../../../src/skills/memory/plugin.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const DAY_MS = 86_400_000;

async function createStore(start = NOW) {
  const clock = new FakeClock(start);
  const store = new FactStore(new MapKeyValueStore(), () => clock.now());
  await store.load();
  return { clock, store };
}

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

class FakeHealth implements HealthRegistry {
  readonly checks: HealthCheck[] = [];

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  async runAll(now: Date): Promise<HealthFinding[]> {
    const findings: HealthFinding[] = [];
    for (const check of this.checks) findings.push(...(await check.run(now)));
    return findings;
  }
}

async function setup(options: { health?: FakeHealth; config?: Record<string, unknown> } = {}) {
  const notifier = new FakeNotifier();
  const capabilities: Record<string, unknown> = { [Contracts.notifier.id]: notifier };
  if (options.health !== undefined) capabilities[Contracts.health.id] = options.health;
  const context = createTestContext({
    now: NOW,
    capabilities,
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  await memorySkill().setup(context.ctx);
  return { context, notifier };
}

function makeReplier(): { replier: Replier; replies: OutgoingMessage[] } {
  const replies: OutgoingMessage[] = [];
  return {
    replies,
    replier: {
      async reply(_conversation: ConversationRef, message: OutgoingMessage) {
        replies.push(message);
      },
    },
  };
}

function choiceMessage(text: string): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'test', address: 'owner' },
    authorId: 'owner',
    fromOwner: true,
    text,
    receivedAt: NOW,
  };
}

describe('stored facts with an end condition', () => {
  it('keeps validUntil and a trimmed untilEvent', async () => {
    const { store } = await createStore();

    const fact = await store.remember({
      subject: 'owner',
      text: '출시 전이라 무료 플랜을 씀',
      source: { kind: 'chat' },
      validUntil: '2026-11-20',
      untilEvent: '  출시  ',
    });

    expect(fact).toMatchObject({ validUntil: '2026-11-20', untilEvent: '출시' });
    expect(fact.expired).toBeUndefined();
    expect(store.all()[0]).toMatchObject({ validUntil: '2026-11-20', untilEvent: '출시' });
  });

  it('rejects a validUntil that is not a calendar date', async () => {
    const { store } = await createStore();

    await expect(
      store.remember({
        subject: 'owner',
        text: '이번 달까지 무료',
        source: { kind: 'chat' },
        validUntil: '2026/11/30',
      }),
    ).rejects.toThrow('validUntil must be YYYY-MM-DD');
  });

  it('drops malformed optional fields but keeps the fact', async () => {
    const kv = new MapKeyValueStore();
    await kv.set('facts', [
      {
        id: 'bad1',
        subject: 'owner',
        text: '형식이 이상한 기억',
        source: { kind: 'chat' },
        learnedAt: NOW.toISOString(),
        confirmedAt: NOW.toISOString(),
        halfLifeDays: 90,
        validUntil: 'tomorrow',
        untilEvent: 42,
        expiredAt: 'not-a-date',
      },
    ]);
    const store = new FactStore(kv, () => NOW);
    await store.load();

    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]?.validUntil).toBeUndefined();
    expect(store.all()[0]?.untilEvent).toBeUndefined();
    expect(store.all()[0]?.expiredAt).toBeUndefined();
  });

  it('expires only after the last valid day and skips expired facts in recall', async () => {
    const { store } = await createStore();
    const fact = await store.remember({
      subject: 'owner',
      text: '이번 주까지 시험 기간',
      source: { kind: 'chat' },
      validUntil: '2026-11-17',
    });

    expect(store.expireDue('2026-11-17')).toEqual([]);
    const expired = store.expireDue('2026-11-18');

    expect(expired.map((entry) => entry.id)).toEqual([fact.id]);
    expect(expired[0]).toMatchObject({ expiredReason: 'date' });
    expect(store.expiredFacts().map((entry) => entry.id)).toEqual([fact.id]);
    expect(await store.recall({ subject: 'owner', limit: 5 })).toEqual([]);
  });

  it('matches an event loosely and does not end the same fact twice', async () => {
    const { store } = await createStore();
    await store.remember({
      subject: 'owner',
      text: '출시 준비 중이라 주말에도 일함',
      source: { kind: 'chat' },
      untilEvent: '출시일',
    });
    await store.remember({ subject: 'owner', text: '출시 전이라 무료', source: { kind: 'chat' }, untilEvent: '출시' });
    await store.remember({ subject: 'owner', text: '이사 준비 중', source: { kind: 'chat' }, untilEvent: '이사' });

    const ended = store.expireEvent('출시');
    expect(ended).toHaveLength(2);
    expect(ended.every((fact) => fact.expiredReason === 'event')).toBe(true);
    expect(store.expireEvent('출시')).toEqual([]);
    expect(store.expiredFacts()).toHaveLength(2);
  });

  it('clears the end condition state when the same fact is confirmed again', async () => {
    const { store } = await createStore();
    const fact = await store.remember({
      subject: 'owner',
      text: '이번 주까지 재택근무',
      source: { kind: 'chat' },
      validUntil: '2026-11-17',
    });
    store.expireDue('2026-11-18');

    const again = await store.remember({ subject: 'owner', text: fact.text, source: { kind: 'chat' } });

    expect(again.expired).toBeUndefined();
    expect(store.all()[0]?.expiredAt).toBeUndefined();
    expect(store.all()[0]?.expiredReason).toBeUndefined();
    expect(await store.recall({ subject: 'owner', limit: 5 })).toHaveLength(1);
  });
});

describe('memory expiry job', () => {
  it('expires the day after validUntil and emits the event once', async () => {
    const { context } = await setup();
    const events: FactExpired[] = [];
    context.bus.on('memory.fact_expired', (payload) => {
      events.push(payload);
    });
    const fact = await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '출시 전이라 광고는 안 함',
      source: { kind: 'chat' },
      validUntil: '2026-11-17',
    });

    await context.scheduler.run('memory.expiry', context.clock.now());
    expect(events).toEqual([]);

    await context.clock.advance(DAY_MS);
    await context.scheduler.run('memory.expiry', context.clock.now());
    await context.scheduler.run('memory.expiry', context.clock.now());

    expect(events).toEqual([{ id: fact.id, subject: 'owner', text: fact.text, reason: 'date' }]);
    const expired = await context.ctx.use(Contracts.memoryExpiry).expired();
    expect(expired).toMatchObject([{ id: fact.id, expired: true }]);
    expect(await context.ctx.use(Contracts.memoryRead).recall({ subject: 'owner', limit: 5 })).toEqual([]);
  });

  it('ends facts when the owner reports the event through the capability', async () => {
    const { context } = await setup();
    const events: FactExpired[] = [];
    context.bus.on('memory.fact_expired', (payload) => {
      events.push(payload);
    });
    const launch = await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '출시 전이라 베타 가격을 씀',
      source: { kind: 'chat' },
      untilEvent: '출시',
    });
    await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '이사 준비 중이라 주말에 시간이 없음',
      source: { kind: 'chat' },
      untilEvent: '이사',
    });

    const ended = await context.ctx.use(Contracts.memoryExpiry).eventHappened('출시');

    expect(ended.map((fact: Fact) => fact.id)).toEqual([launch.id]);
    expect(ended[0]?.expired).toBe(true);
    expect(events).toEqual([{ id: launch.id, subject: 'owner', text: launch.text, reason: 'event' }]);
    expect(await context.ctx.use(Contracts.memoryRead).recall({ subject: 'owner', limit: 5 })).toHaveLength(1);
  });

  it('registers a knowledge health check that reports ended facts', async () => {
    const health = new FakeHealth();
    const { context } = await setup({ health });
    const fact = await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '이번 달까지만 할인 가격',
      source: { kind: 'chat' },
      validUntil: '2026-11-16',
    });
    await context.scheduler.run('memory.expiry', context.clock.now());

    const [finding] = await health.runAll(context.clock.now());

    expect(finding).toMatchObject({ id: 'memory.expired', area: 'knowledge', ok: false });
    expect(finding?.line).toContain(fact.text);
    expect(finding?.fix).toBeDefined();

    await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: fact.text,
      source: { kind: 'chat' },
    });
    const [after] = await health.runAll(context.clock.now());
    expect(after).toMatchObject({ id: 'memory.expired', ok: true });
    expect(after?.fix).toBeUndefined();
  });
});

describe('memory.event_happened tool', () => {
  it('ends matching facts and reports how many', async () => {
    const { context } = await setup();
    const fact = await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '출시 전이라 카드 혜택을 씀',
      source: { kind: 'chat' },
      untilEvent: '출시',
    });
    const evidence = '드디어 출시했어요';

    const outcome = await context.ctx.tools.execute(
      'memory.event_happened',
      { event: '출시', evidence },
      { grounding: [evidence] },
    );

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? outcome.output : undefined).toEqual({
      ended: [{ id: fact.id, text: fact.text }],
      message: '1개 사실을 끝난 것으로 표시했어요.',
    });
  });

  it('rejects mail or web text that was not said by the owner', async () => {
    const { context } = await setup();
    await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '출시 전이라 무료',
      source: { kind: 'chat' },
      untilEvent: '출시',
    });

    const outcome = await context.ctx.tools.execute(
      'memory.event_happened',
      { event: '출시', evidence: '출시했다는 메일' },
      { grounding: ['뉴스레터: 다음 주에 출시합니다'] },
    );

    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(await context.ctx.use(Contracts.memoryExpiry).expired()).toEqual([]);
  });
});

describe('memory.remember end conditions', () => {
  function done<T>(outcome: Awaited<ReturnType<typeof run>>): T {
    if (outcome.status !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
    return outcome.output as T;
  }

  async function run(
    context: Awaited<ReturnType<typeof setup>>['context'],
    input: Record<string, unknown>,
    evidence: string,
  ) {
    return context.ctx.tools.execute('memory.remember', { ...input, evidence }, { grounding: [evidence] });
  }

  it('stores a given end condition without asking', async () => {
    const { context } = await setup();
    const evidence = '이번 주까지 야근이에요';

    const view = done<{ askEnd?: true }>(await run(context, { text: '이번 주까지 야근 중', validUntil: '2026-11-22' }, evidence));

    expect(view.askEnd).toBeUndefined();
    const [fact] = await context.ctx.use(Contracts.memoryRead).recall({ subject: 'owner', limit: 5 });
    expect(fact).toMatchObject({ validUntil: '2026-11-22' });
  });

  it('asks when the fact ends if its wording is time-limited', async () => {
    const { context } = await setup();
    const evidence = '출시 전이라 계속 무료로 쓰고 있어요';

    const view = done<{ askEnd?: true; message?: string }>(
      await run(context, { text: '출시 전이라 무료 플랜을 씀' }, evidence),
    );

    expect(view.askEnd).toBe(true);
    expect(view.message).toBe(
      '언제까지 맞는 사실인가요? 날짜나 일(예: 출시)을 알려 주시면 그때 다시 여쭤볼게요.',
    );
  });

  it('does not ask for a fact that does not look time-limited', async () => {
    const { context } = await setup();
    const evidence = '커피는 아메리카노가 좋아요';

    const view = done<{ askEnd?: true }>(
      await run(context, { text: '커피는 아메리카노를 즐김' }, evidence),
    );

    expect(view.askEnd).toBeUndefined();
  });

  it('detects Korean and English time-limited phrasing', () => {
    expect(isTimeLimited('출시 전이라 무료')).toBe(true);
    expect(isTimeLimited('이번 주까지 야근')).toBe(true);
    expect(isTimeLimited('not yet launched, so no ads')).toBe(true);
    expect(isTimeLimited('커피는 아메리카노를 즐김')).toBe(false);
  });
});

describe('check-in with ended facts', () => {
  it('asks about ended facts first and marks them in the notice', async () => {
    const { context, notifier } = await setup({ config: { checkinWeekday: 0 } });
    const faded = await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '주말에는 등산을 감',
      source: { kind: 'chat' },
      halfLifeDays: 90,
    });
    const ended = await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '출시 전이라 무료 플랜을 씀',
      source: { kind: 'chat' },
      halfLifeDays: 90,
      validUntil: '2026-11-16',
    });

    await context.clock.advance(180 * DAY_MS);
    await context.scheduler.run('memory.expiry', context.clock.now());
    await context.scheduler.run('memory.checkin', context.clock.now());

    const notice = notifier.notices[0];
    expect(notice?.text).toContain(`• ${ended.text} (끝난 것 같아요)`);
    expect(notice?.text).toContain(`• ${faded.text}`);
    const keepIds = (notice?.choices ?? [])
      .filter((choice) => choice.id.startsWith('mem.keep:'))
      .map((choice) => choice.id.slice('mem.keep:'.length));
    expect(keepIds).toEqual([ended.id, faded.id]);

    const { replier, replies } = makeReplier();
    const handler = context.handlers.find((candidate) => candidate.id === 'memory.checkin');
    await handler?.handle(choiceMessage(`(choice: mem.keep:${ended.id})`), replier);

    expect(replies[0]?.text).toBe(`기억해 둘게요: ${ended.text}`);
    const recalled = await context.ctx.use(Contracts.memoryRead).recall({ subject: 'owner', limit: 5 });
    expect(recalled.map((fact) => fact.id)).toContain(ended.id);
  });
});
