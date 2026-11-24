import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { memorySkill } from '../../../src/skills/memory/plugin.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

interface NoteOutput {
  id: string;
  person: string;
  text: string;
  due?: string;
}

interface RecallOutput {
  found: boolean;
  key?: string;
  names?: string[];
  emails?: string[];
  interactions?: { date: string; channel: string; summary: string }[];
  commitments?: { id: string; text: string; direction?: string; done?: boolean }[];
  facts?: { text: string; source: string; date: string }[];
  suggestions?: string[];
}

async function setup() {
  const context = createTestContext({ now: NOW });
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

describe('people.note', () => {
  it('records a commitment quoted from the owner message', async () => {
    const context = await setup();
    const evidence = '민수님한테 금요일까지 자료 보내기로 했어';

    const note = doneOutput<NoteOutput>(
      await execute(
        context,
        'people.note',
        {
          name: '민수님이랑',
          kind: 'promise',
          direction: 'mine',
          text: '금요일까지 자료 보내기',
          due: '2026-11-20',
          evidence,
        },
        [evidence],
      ),
    );

    expect(note.person).toBe('민수');
    expect(note.due).toBe('2026-11-20');

    const recalled = doneOutput<RecallOutput>(await execute(context, 'people.recall', { name: '민수' }));
    expect(recalled.found).toBe(true);
    expect(recalled.key).toBe('민수');
    expect(recalled.commitments).toMatchObject([{ text: '금요일까지 자료 보내기', direction: 'mine' }]);
  });

  it('rejects a commitment that is not grounded in the turn', async () => {
    const context = await setup();

    const outcome = await execute(
      context,
      'people.note',
      { name: '민수', kind: 'promise', direction: 'mine', text: '자료 보내기', evidence: '자료 보내기' },
      ['전혀 다른 말'],
    );

    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(await context.ctx.use(Contracts.peopleRead).openCommitments()).toEqual([]);
  });
});

describe('people.done', () => {
  it('closes one commitment', async () => {
    const context = await setup();
    const evidence = '민수님한테 금요일까지 자료 보내기로 했어';
    const note = doneOutput<NoteOutput>(
      await execute(
        context,
        'people.note',
        { name: '민수', kind: 'promise', direction: 'mine', text: '자료 보내기', evidence },
        [evidence],
      ),
    );

    const closed = doneOutput<{ id: string; done: boolean }>(
      await execute(context, 'people.done', { name: '민수님', commitmentId: note.id }),
    );

    expect(closed).toEqual({ id: note.id, done: true });
    const recalled = doneOutput<RecallOutput>(await execute(context, 'people.recall', { name: '민수' }));
    expect(recalled.commitments).toEqual([]);
  });

  it('fails for an unknown commitment', async () => {
    const context = await setup();

    const outcome = await execute(context, 'people.done', { name: '민수', commitmentId: 'nope' });

    expect(outcome).toEqual({ status: 'failed', error: 'No open commitment nope for 민수' });
  });
});

describe('people.recall', () => {
  it('returns names, last interactions, open commitments and related facts', async () => {
    const context = await setup();
    const evidence = '지은님이랑 어제 커피 마셨어';
    await context.ctx.use(Contracts.memoryWrite).remember({
      subject: '지은',
      text: '지은은 아메리카노를 좋아함',
      source: { kind: 'chat' },
    });
    await execute(
      context,
      'people.note',
      { name: '지은', kind: 'request', direction: 'theirs', text: '자료 요청', evidence },
      [evidence],
    );

    const recalled = doneOutput<RecallOutput>(await execute(context, 'people.recall', { name: '지은' }));

    expect(recalled).toMatchObject({ found: true, key: '지은' });
    expect(recalled.facts).toMatchObject([{ text: '지은은 아메리카노를 좋아함', source: 'chat' }]);
    expect(recalled.commitments).toHaveLength(1);
  });

  it('suggests close names when nobody matches', async () => {
    const context = await setup();
    const evidence = '지은님한테 자료 받기로 했어';
    await execute(
      context,
      'people.note',
      { name: '지은', kind: 'promise', direction: 'theirs', text: '자료 보내기', evidence },
      [evidence],
    );

    const recalled = doneOutput<RecallOutput>(await execute(context, 'people.recall', { name: '지운' }));

    expect(recalled.found).toBe(false);
    expect(recalled.suggestions).toEqual(['지은']);
  });
});

describe('people.read capability', () => {
  it('finds a person by honorific name and lists open commitments', async () => {
    const context = await setup();
    const reader = context.ctx.use(Contracts.peopleRead);
    const evidence = '민수님한테 자료 보내기로 했어';

    await execute(
      context,
      'people.note',
      { name: '민수', kind: 'promise', direction: 'mine', text: '자료 보내기', evidence },
      [evidence],
    );

    expect((await reader.find('민수님'))?.key).toBe('민수');
    expect(await reader.find('없는 사람')).toBeUndefined();
    expect((await reader.openCommitments()).map((entry) => entry.person)).toEqual(['민수']);
  });
});

describe('people.write capability', () => {
  it('records a chat interaction that people.read then finds', async () => {
    const context = await setup();
    await context.ctx.use(Contracts.peopleWrite).noteInteraction(
      { name: '민수' },
      { at: '2026-11-17T09:00:00+09:00', channel: 'chat', summary: '카카오톡 대화', ref: 'r1' },
    );
    const person = await context.ctx.use(Contracts.peopleRead).find('민수');
    expect(person?.interactions.map((entry) => entry.summary)).toEqual(['카카오톡 대화']);
  });
});
