import { describe, expect, it } from 'vitest';
import type { Notice, NoticeResult, Notifier, TodoItem } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { StoredTodo } from '../../../src/skills/todo/store.js';
import { todoSkill } from '../../../src/skills/todo/plugin.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

async function setup(opts: { now?: Date; notifier?: FakeNotifier; seed?: StoredTodo[]; confirmer?: FakeConfirmer } = {}) {
  const context = createTestContext({
    now: opts.now ?? NOW,
    ...(opts.confirmer !== undefined ? { confirmer: opts.confirmer } : {}),
    capabilities:
      opts.notifier !== undefined ? { [Contracts.notifier.id]: opts.notifier } : {},
  });
  if (opts.seed !== undefined) await context.kv.set('items', opts.seed);
  await todoSkill().setup(context.ctx);
  return context;
}

async function execute(context: Awaited<ReturnType<typeof setup>>, name: string, input: unknown, grounding: string[] = []) {
  return context.ctx.tools.execute(name, input, { grounding });
}

function doneOutput<T>(outcome: Awaited<ReturnType<typeof execute>>): T {
  if (outcome.status !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
  return outcome.output as T;
}

async function storedItems(context: Awaited<ReturnType<typeof setup>>): Promise<StoredTodo[]> {
  return (await context.kv.get<StoredTodo[]>('items')) ?? [];
}

describe('todo.add', () => {
  it('adds an undated item with a short id and the injected clock time', async () => {
    const context = await setup();

    const item = doneOutput<TodoItem>(await execute(context, 'todo.add', { text: '우유 사기' }));

    expect(item.id).toHaveLength(8);
    expect(item).toMatchObject({ text: '우유 사기', done: false, createdAt: '2026-11-17T00:00:00.000Z' });
    expect(await storedItems(context)).toHaveLength(1);
  });

  it('stores due and reminder times in the owner zone', async () => {
    const context = await setup();
    const evidence = '내일 오후 3시까지 보고서 내고 2시 30분에 알려줘';

    const item = doneOutput<TodoItem>(
      await execute(
        context,
        'todo.add',
        {
          text: '보고서 내기',
          due: { date: { kind: 'offset', days: 1 }, time: { hour: 3, minute: 0, meridiem: 'pm' } },
          remind: { date: { kind: 'offset', days: 1 }, time: { hour: 2, minute: 30, meridiem: 'pm' } },
          evidence,
        },
        [evidence],
      ),
    );

    expect(item.due).toBe('2026-11-18T15:00:00+09:00');
    expect(item.remindAt).toBe('2026-11-18T14:30:00+09:00');
  });

  it('stores a date-only deadline as a calendar date', async () => {
    const context = await setup();
    const evidence = '내일까지 보고서를 내야 해요';

    const item = doneOutput<TodoItem>(
      await execute(
        context,
        'todo.add',
        { text: '보고서 내기', due: { date: { kind: 'offset', days: 1 } }, evidence },
        [evidence],
      ),
    );

    expect(item.due).toBe('2026-11-18');
  });

  it('rejects a dated item without evidence', async () => {
    const context = await setup();

    const outcome = await execute(
      context,
      'todo.add',
      { text: '보고서 내기', due: { date: { kind: 'offset', days: 1 } } },
      ['내일까지 보고서를 내야 해요'],
    );

    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: 'evidence is required when a due date or reminder is given',
    });
    expect(await storedItems(context)).toHaveLength(0);
  });

  it('rejects evidence that is not in the turn', async () => {
    const context = await setup();

    const outcome = await execute(
      context,
      'todo.add',
      { text: '보고서 내기', due: { date: { kind: 'offset', days: 1 } }, evidence: '내일까지' },
      ['전혀 다른 말'],
    );

    expect(outcome.status).toBe('rejected');
  });

  it('rejects when the due date is not mentioned in the evidence', async () => {
    const context = await setup();

    const outcome = await execute(
      context,
      'todo.add',
      {
        text: '보고서 내기',
        due: { date: { kind: 'month_day', month: 12, day: 25 } },
        evidence: '내일까지 보고서를 내야 해요',
      },
      ['내일까지 보고서를 내야 해요'],
    );

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'the due date is not mentioned in the evidence' });
  });

  it('asks with a localized reason when the time is a guess', async () => {
    const confirmer = new FakeConfirmer('approved');
    const context = await setup({ confirmer });
    const evidence = '내일 3시까지 보고서를 내야 해요';

    const item = doneOutput<TodoItem>(
      await execute(
        context,
        'todo.add',
        {
          text: '보고서 내기',
          due: { date: { kind: 'offset', days: 1 }, time: { hour: 3, minute: 0, meridiem: 'unspecified' } },
          evidence,
        },
        [evidence],
      ),
    );

    expect(item.due).toBe('2026-11-18T15:00:00+09:00');
    expect(confirmer.requests[0]?.note).toContain('오전/오후를 말하지 않아서 추측했어요');
  });
});

describe('todo.list', () => {
  const SEED: StoredTodo[] = [
    { id: 'late', text: '지난 일', due: '2026-11-16', done: false, createdAt: '2026-11-01T00:00:00.000Z' },
    {
      id: 'dated',
      text: '보고서',
      due: '2026-11-20T15:00:00+09:00',
      done: false,
      createdAt: '2026-11-02T00:00:00.000Z',
    },
    { id: 'free', text: '우유', done: false, createdAt: '2026-11-03T00:00:00.000Z' },
    { id: 'done', text: '끝난 일', due: '2026-11-15', done: true, createdAt: '2026-11-04T00:00:00.000Z' },
  ];

  it('lists dated items by due date, then undated items by creation time', async () => {
    const context = await setup({ seed: SEED });

    const items = doneOutput<TodoItem[]>(await execute(context, 'todo.list', {}));

    expect(items.map((item) => item.id)).toEqual(['late', 'dated', 'free']);
  });

  it('includes completed items on request', async () => {
    const context = await setup({ seed: SEED });

    const items = doneOutput<TodoItem[]>(await execute(context, 'todo.list', { includeDone: true }));

    expect(items.map((item) => item.id)).toEqual(['done', 'late', 'dated', 'free']);
  });
});

describe('todo.complete', () => {
  it('marks an item as done and hides it from the default list', async () => {
    const context = await setup({
      seed: [{ id: 'a1', text: '보고서', done: false, createdAt: '2026-11-01T00:00:00.000Z' }],
    });

    const item = doneOutput<TodoItem>(await execute(context, 'todo.complete', { id: 'a1' }));

    expect(item.done).toBe(true);
    expect(item.completedAt).toBe(NOW.toISOString());
    expect(doneOutput<TodoItem[]>(await execute(context, 'todo.list', {}))).toHaveLength(0);
  });

  it('fails for an unknown id', async () => {
    const context = await setup();

    const outcome = await execute(context, 'todo.complete', { id: 'nope' });

    expect(outcome).toEqual({ status: 'failed', error: 'No to-do with id nope' });
  });
});

describe('todo.remove', () => {
  const ITEM: StoredTodo = { id: 'a1', text: '보고서 버리기', done: false, createdAt: '2026-11-01T00:00:00.000Z' };

  it('asks before deleting and shows the item text', async () => {
    const confirmer = new FakeConfirmer('approved');
    const context = await setup({ seed: [ITEM], confirmer });

    const result = doneOutput<{ id: string; removed: boolean }>(
      await execute(context, 'todo.remove', { id: 'a1' }),
    );

    expect(result).toEqual({ id: 'a1', removed: true });
    expect(confirmer.requests[0]?.effects).toEqual(['delete']);
    expect(confirmer.requests[0]?.summary).toBe('할 일 삭제: 보고서 버리기');
    expect(await storedItems(context)).toHaveLength(0);
  });

  it('keeps the item when the owner denies', async () => {
    const context = await setup({ seed: [ITEM], confirmer: new FakeConfirmer('denied') });

    const outcome = await execute(context, 'todo.remove', { id: 'a1' });

    expect(outcome).toEqual({ status: 'denied' });
    expect(await storedItems(context)).toHaveLength(1);
  });
});

describe('todo reminders', () => {
  const PAST = '2026-11-17T08:59:00+09:00';
  const FUTURE = '2026-11-17T10:00:00+09:00';

  it('notifies for due reminders once and marks them', async () => {
    const notifier = new FakeNotifier();
    const context = await setup({
      notifier,
      seed: [
        { id: 'due', text: '보고서 내기', done: false, createdAt: '2026-11-01T00:00:00.000Z', remindAt: PAST },
        { id: 'later', text: '나중 일', done: false, createdAt: '2026-11-02T00:00:00.000Z', remindAt: FUTURE },
        {
          id: 'done',
          text: '끝난 일',
          done: true,
          createdAt: '2026-11-03T00:00:00.000Z',
          remindAt: PAST,
        },
        {
          id: 'already',
          text: '이미 알림',
          done: false,
          createdAt: '2026-11-04T00:00:00.000Z',
          remindAt: PAST,
          reminded: true,
        },
      ],
    });

    await context.scheduler.run('todo.reminders', NOW);

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]).toMatchObject({
      kind: 'todo.reminder',
      urgent: true,
      dedupeKey: 'due',
      text: '알림: 보고서 내기',
      choices: [
        { id: 'todo.done:due', label: '완료' },
        { id: 'todo.snooze:due', label: '10분 뒤' },
      ],
    });
    const items = await storedItems(context);
    expect(items.find((item) => item.id === 'due')?.reminded).toBe(true);
    expect(items.find((item) => item.id === 'later')?.reminded).toBeUndefined();

    await context.scheduler.run('todo.reminders', NOW);
    expect(notifier.notices).toHaveLength(1);
  });

  it('waits for a notifier to appear and retries on the next sweep', async () => {
    const notifier = new FakeNotifier();
    const context = await setup({
      seed: [{ id: 'due', text: '보고서 내기', done: false, createdAt: '2026-11-01T00:00:00.000Z', remindAt: PAST }],
    });

    await context.scheduler.run('todo.reminders', NOW);

    expect(notifier.notices).toHaveLength(0);
    expect((await storedItems(context))[0]?.reminded).toBeUndefined();

    context.provided.set(Contracts.notifier.id, notifier);
    await context.scheduler.run('todo.reminders', NOW);

    expect(notifier.notices).toHaveLength(1);
    expect((await storedItems(context))[0]?.reminded).toBe(true);
  });
});

describe('todo.read capability', () => {
  it('provides open to-dos to other skills', async () => {
    const context = await setup({
      seed: [
        { id: 'open', text: '열린 일', done: false, createdAt: '2026-11-01T00:00:00.000Z' },
        { id: 'done', text: '끝난 일', done: true, createdAt: '2026-11-02T00:00:00.000Z' },
      ],
    });

    const open = await context.ctx.use(Contracts.todoRead).open();

    expect(open.map((item) => item.id)).toEqual(['open']);
  });
});
