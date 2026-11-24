import { describe, expect, it } from 'vitest';
import type { IncomingMessage, MessageHandler, OutgoingMessage, Replier } from '../../../src/core/conversation/types.js';
import type { Notice, NoticeResult, Notifier } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { interviewSkill } from '../../../src/skills/interview/plugin.js';
import { memorySkill } from '../../../src/skills/memory/plugin.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

async function setup(notifier?: FakeNotifier) {
  const context = createTestContext({
    now: NOW,
    capabilities: notifier !== undefined ? { [Contracts.notifier.id]: notifier } : {},
  });
  await memorySkill().setup(context.ctx);
  await interviewSkill().setup(context.ctx);
  return context;
}

type Context = Awaited<ReturnType<typeof setup>>;

function handlerOf(context: Context, id: string): MessageHandler {
  const found = context.handlers.find((handler) => handler.id === id);
  if (found === undefined) throw new Error(`No handler ${id}`);
  return found;
}

function message(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'c1', address: 'a1' },
    authorId: fromOwner ? 'owner' : 'other',
    fromOwner,
    text,
    receivedAt: NOW,
  };
}

async function send(context: Context, id: string, text: string, fromOwner = true) {
  const replies: OutgoingMessage[] = [];
  const replier: Replier = {
    async reply(_to, outgoing) {
      replies.push(outgoing);
    },
  };
  const result = await handlerOf(context, id).handle(message(text, fromOwner), replier);
  return { result, replies };
}

async function ownerFacts(context: Context) {
  return context.ctx.use(Contracts.memoryRead).recall({ subject: 'owner', limit: 20 });
}

describe('interview questions', () => {
  it('asks the first question with choices and a skip button on "인터뷰"', async () => {
    const context = await setup();

    const { result, replies } = await send(context, 'interview.trigger', '인터뷰');

    expect(result).toBe('handled');
    expect(replies[0]?.text).toContain('하루 중 언제 머리가 가장 잘 돌아가나요?');
    expect(replies[0]?.choices?.[0]).toEqual({ id: 'interview:focus_time:morning', label: '아침' });
    expect(replies[0]?.choices?.at(-1)).toEqual({ id: 'interview:focus_time:skip', label: '건너뛰기' });
  });

  it('also answers English triggers and ignores other messages', async () => {
    const context = await setup();

    expect((await send(context, 'interview.trigger', 'ask me questions')).result).toBe('handled');
    expect((await send(context, 'interview.trigger', '오늘 날씨 어때?')).result).toBe('pass');
  });

  it('passes choices that belong to someone else', async () => {
    const context = await setup();

    const { result } = await send(context, 'interview.answers', '(choice: todo:abc:done)');

    expect(result).toBe('pass');
  });
});

describe('answering', () => {
  it('stores the chosen option as an interview fact and asks the next question', async () => {
    const context = await setup();

    const { result, replies } = await send(context, 'interview.answers', '(choice: interview:focus_time:morning)');

    expect(result).toBe('handled');
    expect(replies[0]?.text).toContain('기억해 둘게요.');
    expect(replies[0]?.text).toContain('제가 답할 때 어느 정도 길이가 좋으세요?');
    const facts = await ownerFacts(context);
    expect(facts).toMatchObject([
      { text: '집중은 아침에 가장 잘 된다', source: { kind: 'interview', ref: 'focus_time' } },
    ]);
  });

  it('replaces the old fact when a question is answered again', async () => {
    const context = await setup();

    await send(context, 'interview.answers', '(choice: interview:focus_time:morning)');
    await send(context, 'interview.answers', '(choice: interview:focus_time:night)');

    const facts = await ownerFacts(context);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      text: '집중은 밤에 잘 된다',
      source: { kind: 'interview', ref: 'focus_time' },
    });
  });

  it('does not act on a non-owner choice', async () => {
    const context = await setup();

    const { result } = await send(context, 'interview.answers', '(choice: interview:focus_time:morning)', false);

    expect(result).toBe('pass');
    expect(await ownerFacts(context)).toEqual([]);
  });
});

describe('daily asking', () => {
  it('asks the next question once the previous one was answered', async () => {
    const notifier = new FakeNotifier();
    const context = await setup(notifier);
    await send(context, 'interview.trigger', '인터뷰');
    await send(context, 'interview.answers', '(choice: interview:focus_time:morning)');

    await context.scheduler.run('interview.daily', NOW);

    expect(notifier.notices).toMatchObject([
      { kind: 'interview.question', text: '제가 답할 때 어느 정도 길이가 좋으세요?' },
    ]);
    expect(notifier.notices[0]?.dedupeKey).toBe('interview:reply_length');
  });

  it('waits while the last question is unanswered', async () => {
    const notifier = new FakeNotifier();
    const context = await setup(notifier);
    await send(context, 'interview.trigger', '인터뷰');

    await context.scheduler.run('interview.daily', NOW);

    expect(notifier.notices).toEqual([]);
  });

  it('pauses after three skips in a row, but the owner can still ask', async () => {
    const notifier = new FakeNotifier();
    const context = await setup(notifier);

    await send(context, 'interview.answers', '(choice: interview:focus_time:skip)');
    await send(context, 'interview.answers', '(choice: interview:reply_length:skip)');
    await send(context, 'interview.answers', '(choice: interview:notifications:skip)');

    await context.scheduler.run('interview.daily', NOW);
    expect(notifier.notices).toEqual([]);

    const { result, replies } = await send(context, 'interview.trigger', '질문해 줘');
    expect(result).toBe('handled');
    expect(replies[0]?.text).toContain('이동은 주로 어떻게 하세요?');
  });
});

describe('app.started', () => {
  it('sends the intro and the first question once, then stays quiet', async () => {
    const notifier = new FakeNotifier();
    const context = await setup(notifier);
    await context.bus.emit('app.started', { at: NOW });
    await context.bus.emit('app.started', { at: NOW });

    expect(notifier.notices.filter((notice) => notice.kind === 'interview.intro')).toHaveLength(1);
    expect(notifier.notices.filter((notice) => notice.kind === 'interview.question')).toHaveLength(1);
    expect(notifier.notices.at(-1)?.dedupeKey).toBe('interview:focus_time');
  });

  it('does not introduce itself when no notifier is connected', async () => {
    const context = await setup();

    await context.bus.emit('app.started', { at: NOW });

    expect(await ownerFacts(context)).toEqual([]);
  });
});
