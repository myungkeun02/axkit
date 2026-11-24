import { describe, expect, it } from 'vitest';
import type { Notice, NoticeResult, Notifier } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { IncomingMessage, MessageHandler, Replier } from '../../../src/core/conversation/types.js';
import { todoSkill } from '../../../src/skills/todo/plugin.js';
import type { StoredTodo } from '../../../src/skills/todo/store.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const PAST = '2026-11-17T08:00:00+09:00';

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

async function setup(opts: { seed?: StoredTodo[]; notifier?: FakeNotifier } = {}) {
  const context = createTestContext({
    now: NOW,
    capabilities: opts.notifier !== undefined ? { [Contracts.notifier.id]: opts.notifier } : {},
  });
  if (opts.seed !== undefined) await context.kv.set('items', opts.seed);
  await todoSkill().setup(context.ctx);
  const handler = context.handlers.find((candidate) => candidate.id === 'todo.buttons');
  if (handler === undefined) throw new Error('todo.buttons handler was not registered');
  return { context, handler };
}

function message(text: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'c1', address: 'a1' },
    authorId: 'owner',
    fromOwner: true,
    text,
    receivedAt: NOW,
    ...overrides,
  };
}

async function press(
  handler: MessageHandler,
  text: string,
  overrides: Partial<IncomingMessage> = {},
): Promise<{ result: string; replies: string[] }> {
  const replies: string[] = [];
  const replier: Replier = {
    reply: async (_to, outgoing) => {
      replies.push(outgoing.text);
    },
  };
  const result = await handler.handle(message(text, overrides), replier);
  return { result, replies };
}

async function storedItems(context: Awaited<ReturnType<typeof setup>>['context']): Promise<StoredTodo[]> {
  return (await context.kv.get<StoredTodo[]>('items')) ?? [];
}

function item(overrides: Partial<StoredTodo> = {}): StoredTodo {
  return { id: 'a1', text: '보고서 내기', done: false, createdAt: '2026-11-01T00:00:00.000Z', ...overrides };
}

describe('todo reminder buttons', () => {
  it('marks the item done and replies with its text', async () => {
    const { context, handler } = await setup({ seed: [item()] });

    const { result, replies } = await press(handler, '(choice: todo.done:a1)');

    expect(result).toBe('handled');
    expect(replies).toEqual(['완료했어요: 보고서 내기']);
    const [stored] = await storedItems(context);
    expect(stored).toMatchObject({ done: true, completedAt: NOW.toISOString() });
  });

  it('snoozes the reminder by ten minutes in the owner time zone', async () => {
    const { context, handler } = await setup({ seed: [item({ remindAt: PAST, reminded: true })] });

    const { result, replies } = await press(handler, '(choice: todo.snooze:a1)');

    expect(result).toBe('handled');
    expect(replies).toEqual(['10분 뒤에 다시 알려드릴게요: 보고서 내기']);
    const [stored] = await storedItems(context);
    expect(stored).toMatchObject({ remindAt: '2026-11-17T09:10:00+09:00', reminded: false });
  });

  it('tells the owner when the item does not exist', async () => {
    const { context, handler } = await setup({ seed: [item()] });

    const { result, replies } = await press(handler, '(choice: todo.done:missing)');

    expect(result).toBe('handled');
    expect(replies).toEqual(['그 할 일을 찾을 수 없어요.']);
    expect(await storedItems(context)).toHaveLength(1);
  });

  it('does not complete an item that is already done', async () => {
    const { context, handler } = await setup({
      seed: [item({ done: true, completedAt: '2026-11-01T00:00:00.000Z' })],
    });

    expect((await press(handler, '(choice: todo.done:a1)')).replies).toEqual(['이미 완료한 일이에요.']);
    expect((await press(handler, '(choice: todo.snooze:a1)')).replies).toEqual(['이미 완료한 일이에요.']);
    const [stored] = await storedItems(context);
    expect(stored?.completedAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('ignores non-owner presses', async () => {
    const { handler } = await setup({ seed: [item()] });

    const { result, replies } = await press(handler, '(choice: todo.done:a1)', { fromOwner: false });

    expect(result).toBe('pass');
    expect(replies).toEqual([]);
  });

  it('passes on messages that are not its own button ids', async () => {
    const { handler } = await setup({ seed: [item()] });

    expect((await press(handler, '안녕')).result).toBe('pass');
    expect((await press(handler, '(choice: calendar.ok:1)')).result).toBe('pass');
    expect((await press(handler, '(choice: todo.done:)')).result).toBe('pass');
  });

  it('reminds again ten minutes after a snooze', async () => {
    const notifier = new FakeNotifier();
    const { context, handler } = await setup({ notifier, seed: [item({ remindAt: PAST, reminded: true })] });

    await press(handler, '(choice: todo.snooze:a1)');
    await context.scheduler.run('todo.reminders', NOW);
    expect(notifier.notices).toHaveLength(0);

    await context.scheduler.run('todo.reminders', new Date('2026-11-17T09:10:00+09:00'));

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.text).toBe('알림: 보고서 내기');
    expect((await storedItems(context))[0]?.reminded).toBe(true);
  });
});
