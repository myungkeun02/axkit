import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Fact, FactSourceKind } from '../../../src/core/contracts/index.js';
import { memorySkill } from '../../../src/skills/memory/plugin.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

interface FactView {
  id: string;
  subject: string;
  text: string;
  source: FactSourceKind;
  date: string;
  strength: number;
}

async function setup(confirmer?: FakeConfirmer) {
  const context = createTestContext({
    now: NOW,
    ...(confirmer !== undefined ? { confirmer } : {}),
  });
  await memorySkill().setup(context.ctx);
  return context;
}

async function execute(
  context: Awaited<ReturnType<typeof setup>>,
  name: string,
  input: unknown,
  grounding: string[] = [],
) {
  return context.ctx.tools.execute(name, input, { grounding });
}

function doneOutput<T>(outcome: Awaited<ReturnType<typeof execute>>): T {
  if (outcome.status !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
  return outcome.output as T;
}

describe('memory.remember', () => {
  it('keeps a fact quoted from the owner message', async () => {
    const context = await setup();
    const evidence = '커피는 아메리카노가 좋아요';

    const fact = doneOutput<FactView>(
      await execute(context, 'memory.remember', { text: '커피는 아메리카노를 즐김', evidence }, [evidence]),
    );

    expect(fact).toMatchObject({
      subject: 'owner',
      text: '커피는 아메리카노를 즐김',
      source: 'chat',
      date: '2026-11-17',
      strength: 1,
    });
    expect(fact.id).toHaveLength(8);
  });

  it('rejects evidence that is not in the turn', async () => {
    const context = await setup();

    const outcome = await execute(
      context,
      'memory.remember',
      { text: '커피는 아메리카노를 즐김', evidence: '커피 좋아함' },
      ['전혀 다른 말'],
    );

    expect(outcome).toMatchObject({ status: 'rejected' });
    expect((await context.ctx.use(Contracts.memoryRead).recall({ limit: 10 }))).toEqual([]);
  });

  it('keys a fact about a person by their normalized name', async () => {
    const context = await setup();
    const evidence = '민수님이랑 다음 주에 보기로 했어요';

    const fact = doneOutput<FactView>(
      await execute(
        context,
        'memory.remember',
        { text: '민수와 다음 주에 만나기로 함', about: '민수님이랑', evidence },
        [evidence],
      ),
    );

    expect(fact.subject).toBe('민수');
  });
});

describe('memory.recall', () => {
  it('returns facts with source, date and rounded strength', async () => {
    const context = await setup();
    await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '이동은 주로 대중교통',
      source: { kind: 'interview', ref: 'commute' },
      halfLifeDays: 365,
    });
    await context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '커피는 아메리카노',
      source: { kind: 'chat' },
    });

    const facts = doneOutput<FactView[]>(
      await execute(context, 'memory.recall', { query: '대중교통 타는 편이야?' }),
    );

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ text: '이동은 주로 대중교통', source: 'interview' });
    expect(facts[0]?.strength).toBe(1);
  });
});

describe('memory.forget', () => {
  async function seed(context: Awaited<ReturnType<typeof setup>>): Promise<Fact> {
    return context.ctx.use(Contracts.memoryWrite).remember({
      subject: 'owner',
      text: '지워야 할 기억',
      source: { kind: 'chat' },
    });
  }

  it('always asks, showing the fact text', async () => {
    const confirmer = new FakeConfirmer('approved');
    const context = await setup(confirmer);
    const fact = await seed(context);

    const result = doneOutput<{ id: string; removed: boolean }>(
      await execute(context, 'memory.forget', { id: fact.id }),
    );

    expect(result).toEqual({ id: fact.id, removed: true });
    expect(confirmer.requests[0]?.effects).toEqual(['delete']);
    expect(confirmer.requests[0]?.summary).toBe('기억 삭제: 지워야 할 기억');
    expect((await context.ctx.use(Contracts.memoryRead).recall({ limit: 10 }))).toEqual([]);
  });

  it('keeps the fact when the owner denies', async () => {
    const context = await setup(new FakeConfirmer('denied'));
    const fact = await seed(context);

    const outcome = await execute(context, 'memory.forget', { id: fact.id });

    expect(outcome).toEqual({ status: 'denied' });
    expect(await context.ctx.use(Contracts.memoryRead).recall({ limit: 10 })).toHaveLength(1);
  });
});
