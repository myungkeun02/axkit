import { describe, expect, it } from 'vitest';
import type { Notice, NoticeResult, Notifier, RememberInput, ReviewAnswer, MemoryWriter } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { IncomingMessage, MessageHandler, OutgoingMessage, Replier } from '../../../src/core/conversation/types.js';
import { interviewSkill } from '../../../src/skills/interview/plugin.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const REVIEW_ID = 'knowledge.profile';

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

class FakeMemoryWriter implements MemoryWriter {
  readonly inputs: RememberInput[] = [];

  async remember(input: RememberInput): Promise<{
    id: string;
    subject: string;
    text: string;
    source: RememberInput['source'];
    at: string;
    strength: number;
  }> {
    this.inputs.push(input);
    return { id: `fact-${this.inputs.length}`, subject: input.subject, text: input.text, source: input.source, at: NOW.toISOString(), strength: 1 };
  }
}

async function setup() {
  const notifier = new FakeNotifier();
  const memory = new FakeMemoryWriter();
  const context = createTestContext({
    now: NOW,
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.memoryWrite.id]: memory,
    },
  });
  await interviewSkill().setup(context.ctx);
  return { context, notifier, memory };
}

type Context = Awaited<ReturnType<typeof setup>>['context'];

function handlerOf(context: Context): MessageHandler {
  const found = context.handlers.find((handler) => handler.id === 'interview.review');
  if (found === undefined) throw new Error('No review handler');
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

async function send(context: Context, text: string, fromOwner = true) {
  const replies: OutgoingMessage[] = [];
  const replier: Replier = {
    async reply(_to, outgoing) {
      replies.push(outgoing);
    },
  };
  const result = await handlerOf(context).handle(message(text, fromOwner), replier);
  return { result, replies };
}

function answersOf(context: Context): ReviewAnswer[] {
  const answers: ReviewAnswer[] = [];
  context.bus.on('review.answer', (answer) => {
    answers.push(answer);
  });
  return answers;
}

const ITEMS = [
  { id: 'line-role', text: '개발자예요.' },
  { id: 'line-org', text: '회사는 예전 회사예요.' },
  { id: 'line-interest', text: '주말에는 등산을 해요.' },
];

async function start(context: Context, items = ITEMS): Promise<void> {
  await context.ctx.use(Contracts.ownerReview).start({
    id: REVIEW_ID,
    title: '제가 알아본 내용이에요',
    items,
  });
}

describe('review card', () => {
  it('numbers the lines and offers confirm and fix choices', async () => {
    const { context, notifier } = await setup();

    await start(context);

    const card = notifier.notices[0];
    expect(card?.kind).toBe('review.card');
    expect(card?.text).toBe(
      '제가 알아본 내용이에요\n\n1. 개발자예요.\n2. 회사는 예전 회사예요.\n3. 주말에는 등산을 해요.\n\n맞는지 봐 주세요. 틀린 줄이 있으면 [고칠 줄 있어요]를 누르고 번호로 고쳐 주세요 (예: 2 회사는 ○○예요).',
    );
    expect(card?.choices).toEqual([
      { id: `review:${REVIEW_ID}:ok`, label: '다 맞아요' },
      { id: `review:${REVIEW_ID}:fix`, label: '고칠 줄 있어요' },
    ]);
    expect(card?.dedupeKey).toBe(`review:${REVIEW_ID}:${NOW.toISOString()}`);
  });

  it('keeps the card under 1900 characters and shows at most 25 clipped lines', async () => {
    const { context, notifier } = await setup();
    const items = Array.from({ length: 40 }, (_value, index) => ({ id: `i${index}`, text: 'x'.repeat(300) }));

    await start(context, items);

    const text = notifier.notices[0]?.text ?? '';
    expect(text.length).toBeLessThan(1900);
    expect(text).not.toContain('26. ');
    expect(text).toContain(`${'x'.repeat(159)}…`);
  });

  it('replaces an existing review with the same id', async () => {
    const { context, notifier } = await setup();
    await start(context);
    await context.ctx.use(Contracts.ownerReview).start({
      id: REVIEW_ID,
      title: '새 카드',
      items: [{ id: 'only', text: '하나' }],
    });

    expect(notifier.notices).toHaveLength(2);
    const ok = await send(context, `(choice: review:${REVIEW_ID}:ok)`);
    expect(ok.result).toBe('handled');
  });
});

describe('review buttons', () => {
  it('confirms every line and drops the review on ok', async () => {
    const { context } = await setup();
    await start(context);
    const answers = answersOf(context);

    const { result, replies } = await send(context, `(choice: review:${REVIEW_ID}:ok)`);

    expect(result).toBe('handled');
    expect(replies[0]?.text).toBe('확인해 주셔서 고마워요.');
    expect(answers).toEqual(ITEMS.map((item) => ({ reviewId: REVIEW_ID, itemId: item.id, verdict: 'confirmed' })));
    expect((await send(context, `(choice: review:${REVIEW_ID}:ok)`)).result).toBe('pass');
  });

  it('turns on fixing and explains the correction format', async () => {
    const { context } = await setup();
    await start(context);

    const { result, replies } = await send(context, `(choice: review:${REVIEW_ID}:fix)`);

    expect(result).toBe('handled');
    expect(replies[0]?.text).toContain('틀린 줄 번호와 바른 내용을 적어 주세요.');
    expect(replies[0]?.text).toContain("'끝'");
  });

  it('ignores choices that belong to another handler or a missing review', async () => {
    const { context } = await setup();

    expect((await send(context, '(choice: todo:abc:done)')).result).toBe('pass');
    expect((await send(context, `(choice: review:${REVIEW_ID}:ok)`)).result).toBe('pass');
  });
});

describe('corrections', () => {
  it('emits a corrected answer and stores an interview fact', async () => {
    const { context, memory } = await setup();
    await start(context);
    const answers = answersOf(context);
    await send(context, `(choice: review:${REVIEW_ID}:fix)`);

    const { result, replies } = await send(context, '2 회사는 A예요');

    expect(result).toBe('handled');
    expect(answers).toEqual([
      { reviewId: REVIEW_ID, itemId: 'line-org', verdict: 'corrected', text: '회사는 A예요' },
    ]);
    expect(memory.inputs).toEqual([
      {
        subject: 'owner',
        text: '회사는 A예요',
        source: { kind: 'interview', ref: `review:${REVIEW_ID}:line-org` },
        halfLifeDays: 365,
      },
    ]);
    expect(replies[0]?.text).toBe('2번 고쳤어요.');
  });

  it('accepts a line with 번 and no space between number and body in fixing mode', async () => {
    const { context } = await setup();
    await start(context);
    await send(context, `(choice: review:${REVIEW_ID}:fix)`);
    const answers = answersOf(context);

    await send(context, '2번회사는 A예요');

    expect(answers).toMatchObject([{ itemId: 'line-org', verdict: 'corrected', text: '회사는 A예요' }]);
  });

  it('treats "3번 출구로 와" as chat outside fixing mode, and fixing mode ends after six hours', async () => {
    const { context } = await setup();
    await start(context);
    const answers = answersOf(context);

    expect((await send(context, '3번 출구로 와')).result).toBe('pass');
    await send(context, `(choice: review:${REVIEW_ID}:fix)`);
    await context.clock.advance(7 * 60 * 60 * 1000);
    expect((await send(context, '2 회사는 A예요')).result).toBe('pass');
    expect(answers).toEqual([]);
  });

  it('removes a line and does not remember anything', async () => {
    const { context, memory } = await setup();
    await start(context);
    const answers = answersOf(context);

    const { replies } = await send(context, '3 삭제');

    expect(answers).toEqual([{ reviewId: REVIEW_ID, itemId: 'line-interest', verdict: 'removed' }]);
    expect(memory.inputs).toEqual([]);
    expect(replies[0]?.text).toBe('3번 지웠어요.');
  });

  it('replies with the range and changes nothing when the number is outside the card', async () => {
    const { context } = await setup();
    await start(context);
    const answers = answersOf(context);

    const { result, replies } = await send(context, '5 삭제');

    expect(result).toBe('handled');
    expect(replies[0]?.text).toBe('1번부터 3번 사이의 번호로 적어 주세요.');
    expect(answers).toEqual([]);
  });

  it('passes a numbered message without 번 when the review is not in fixing mode', async () => {
    const { context } = await setup();
    await start(context);
    const answers = answersOf(context);

    expect((await send(context, '2 회사는 A예요')).result).toBe('pass');
    expect(answers).toEqual([]);
  });

  it('drops the review on "끝" while fixing', async () => {
    const { context } = await setup();
    await start(context);
    await send(context, `(choice: review:${REVIEW_ID}:fix)`);

    const { result, replies } = await send(context, '끝');

    expect(result).toBe('handled');
    expect(replies[0]?.text).toContain('고친 내용을 반영했어요.');
    expect((await send(context, '2번 고쳐 주세요')).result).toBe('pass');
  });
});

describe('show the card again', () => {
  it('resends the newest pending review and says when there is none', async () => {
    const { context, notifier } = await setup();
    await start(context);

    const { result, replies } = await send(context, '확인 카드 다시');

    expect(result).toBe('handled');
    expect(replies[0]?.text).toContain('확인 카드를 다시 보여 드릴게요.');
    expect(notifier.notices).toHaveLength(2);
    expect(notifier.notices[1]?.text).toContain('1. 개발자예요.');

    await send(context, `(choice: review:${REVIEW_ID}:ok)`);
    const none = await send(context, '확인 카드 다시');
    expect(none.replies[0]?.text).toBe('다시 보여 드릴 확인 카드가 없어요.');
  });
});

describe('ownership', () => {
  it('never answers a non-owner', async () => {
    const { context } = await setup();
    await start(context);
    const answers = answersOf(context);

    expect((await send(context, `(choice: review:${REVIEW_ID}:ok)`, false)).result).toBe('pass');
    expect((await send(context, '3 삭제', false)).result).toBe('pass');
    expect(answers).toEqual([]);
  });
});
