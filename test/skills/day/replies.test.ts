import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { IncomingMessage, Replier } from '../../../src/core/conversation/types.js';
import type { MailMessage, MailSummary } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { daySkill } from '../../../src/skills/day/plugin.js';
import { createTestContext, FakeConfirmer, ScriptedLlm } from '../../support/context.js';
import { FakeAwaiting, FakeMailReader, FakeNotifier, FakeReplier, summary } from './helpers.js';

const NOW = new Date('2026-11-17T17:30:00+09:00');

const message: MailMessage = {
  id: 'm1',
  threadId: 't1',
  from: '민수 <minsu@example.com>',
  to: ['owner@example.com'],
  cc: [],
  subject: '견적서 회신',
  snippet: '확인 부탁드려요',
  receivedAt: new Date('2026-11-15T09:00:00+09:00'),
  unread: true,
  important: false,
  body: '견적서 확인 부탁드려요. 언제까지 가능하세요?',
};

function incoming(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'in-1',
    conversation: { channelId: 'discord', address: 'dm' },
    authorId: 'owner',
    fromOwner,
    text,
    receivedAt: NOW,
  };
}

class RecordingDraftTool {
  readonly calls: { messageId: string; body: string }[] = [];
}

async function setup(options: {
  awaiting?: FakeAwaiting;
  llm?: ScriptedLlm;
  mail?: FakeMailReader;
  withDraftTool?: boolean;
} = {}) {
  const notifier = new FakeNotifier();
  const awaiting = options.awaiting ?? new FakeAwaiting([summary()]);
  const mail = options.mail ?? new FakeMailReader([], message);
  const context = createTestContext({
    now: NOW,
    llm: options.llm ?? new ScriptedLlm(),
    confirmer: new FakeConfirmer('approved'),
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.mailAwaiting.id]: awaiting,
      [Contracts.mailRead.id]: mail,
    },
  });
  await daySkill().setup(context.ctx);

  const tool = new RecordingDraftTool();
  if (options.withDraftTool ?? true) {
    context.ctx.registerTool({
      name: 'mail.draft_reply',
      description: 'fake draft',
      input: z.object({ messageId: z.string(), body: z.string() }),
      effects: ['write'],
      async run(input) {
        tool.calls.push(input);
        return { draftId: 'd1', to: [message.from], cc: [], subject: `Re: ${message.subject}`, body: input.body };
      },
    });
  }

  const handler = context.handlers.find((candidate) => candidate.id === 'day.replies.draft');
  expect(handler).toBeDefined();
  return { notifier, awaiting, mail, tool, handler: handler!, ...context };
}

describe('day.replies digest', () => {
  it('lists awaiting mail with a draft button per message', async () => {
    const awaiting = new FakeAwaiting([
      summary(),
      summary({ id: 'm2', from: '지은 <jieun@example.com>', subject: '다음 주 일정', receivedAt: new Date('2026-11-16T09:00:00+09:00') }),
    ]);
    const { notifier, scheduler } = await setup({ awaiting });

    await scheduler.run('day.replies', NOW);

    expect(awaiting.queries[0]).toEqual({ olderThanHours: 24, newerThanDays: 7, limit: 5 });
    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice?.kind).toBe('day.replies');
    expect(notice?.dedupeKey).toBe('2026-11-17');
    expect(notice?.text).toContain('답을 기다리는 메일이 2통 있어요.');
    expect(notice?.text).toContain('1) 민수님 — 견적서 회신 (2일 전)');
    expect(notice?.text).toContain('2) 지은님 — 다음 주 일정 (1일 전)');
    expect(notice?.text).toContain('초안을 써서 먼저 보여 드릴게요');
    expect(notice?.choices).toEqual([
      { id: 'day.draft:m1', label: '1번 민수님께 답장 쓰기' },
      { id: 'day.draft:m2', label: '2번 지은님께 답장 쓰기' },
    ]);
  });

  it('leaves out robots, notices and invitations, and says what each person wants', async () => {
    const awaiting = new FakeAwaiting([
      summary(),
      summary({ id: 'm2', from: 'Google Drive <drive-shares-dm-noreply@google.com>', subject: '문서가 공유됨' }),
      summary({ id: 'm3', from: '지은 <jieun@example.com>', subject: '초대: 주간 회의' }),
    ]);
    const { notifier, scheduler, ctx } = await setup({ awaiting });
    await ctx.bus.emit('mail.triaged', { id: 'm1', from: '민수 <minsu@example.com>', subject: '견적서 회신', summary: '민수님이 견적서 확인을 부탁했어요', kind: 'question', importance: 'normal' });
    await ctx.bus.emit('mail.triaged', { id: 'm3', from: '지은 <jieun@example.com>', subject: '초대: 주간 회의', summary: '주간 회의 초대', kind: 'invitation', importance: 'normal' });
    await scheduler.run('day.replies', NOW);
    expect(notifier.notices[0]?.text).toContain('답을 기다리는 메일이 1통 있어요.');
    expect(notifier.notices[0]?.text).toContain('1) 민수님 — 민수님이 견적서 확인을 부탁했어요');
  });

  it('truncates the button label but keeps the id whole', async () => {
    const long = '아주 긴 제목이 계속 이어지는 메일입니다';
    const { notifier, scheduler } = await setup({ awaiting: new FakeAwaiting([summary({ subject: long })]) });

    await scheduler.run('day.replies', NOW);
    expect(notifier.notices[0]?.choices?.[0]).toEqual({ id: 'day.draft:m1', label: '1번 민수님께 답장 쓰기' });
    expect(notifier.notices[0]?.text).toContain(long);
  });

  it('skips a message whose draft id would exceed the button limit', async () => {
    const id = 'x'.repeat(90);
    const { notifier, scheduler } = await setup({ awaiting: new FakeAwaiting([summary({ id })]) });

    await scheduler.run('day.replies', NOW);
    expect(notifier.notices[0]?.choices).toBeUndefined();
    expect(notifier.notices[0]?.text).toContain('(2일 전)');
  });

  it('stays quiet when nothing is awaiting', async () => {
    const { notifier, scheduler } = await setup({ awaiting: new FakeAwaiting([]) });
    await scheduler.run('day.replies', NOW);
    expect(notifier.notices).toHaveLength(0);
  });
});

describe('day.replies draft handler', () => {
  it('drafts a reply through the mail tool and says it is not sent', async () => {
    const llm = new ScriptedLlm(['네, 확인했습니다. 내일까지 보내 드릴게요.']);
    const { handler, tool } = await setup({ llm });
    const replier: Replier = new FakeReplier();

    const result = await handler.handle(incoming('(choice: day.draft:m1)'), replier);

    expect(result).toBe('handled');
    expect(tool.calls).toEqual([{ messageId: 'm1', body: '네, 확인했습니다. 내일까지 보내 드릴게요.' }]);
    const request = llm.requests[0];
    expect(request).toMatchObject({ purpose: 'day.reply_draft', tier: 'standard', sensitivity: 'sensitive' });
    const userMessage = request?.messages.at(-1)?.content ?? '';
    expect(userMessage).toContain('<data kind="mail">');
    expect(userMessage).toContain('견적서 확인 부탁드려요');
    expect(userMessage).toContain('</data>');
    const replies = (replier as FakeReplier).replies;
    expect(replies[0]?.message.text).toContain('네, 확인했습니다. 내일까지 보내 드릴게요.');
    expect(replies[0]?.message.text).toContain('아직 보내지 않았어요');
    expect(replies[0]?.message.text).toContain('결재 카드로 한 번 더');
  });

  it('passes on messages from anyone other than the owner', async () => {
    const llm = new ScriptedLlm([]);
    const { handler, tool } = await setup({ llm });
    const replier = new FakeReplier();

    await expect(handler.handle(incoming('(choice: day.draft:m1)', false), replier)).resolves.toBe('pass');
    expect(tool.calls).toHaveLength(0);
    expect(replier.replies).toHaveLength(0);
  });

  it('passes on choices that are not its own', async () => {
    const { handler, tool } = await setup();
    const replier = new FakeReplier();

    await expect(handler.handle(incoming('(choice: day.med_done:0:2026-11-17)'), replier)).resolves.toBe('pass');
    await expect(handler.handle(incoming('hello'), replier)).resolves.toBe('pass');
    expect(tool.calls).toHaveLength(0);
  });

  it('explains that mail is not connected when the tool is missing', async () => {
    const { handler } = await setup({ withDraftTool: false });
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: day.draft:m1)'), replier);
    expect(replier.replies[0]?.message.text).toContain('메일이 연결되지 않았어요');
  });

  it('reports a failed draft instead of crashing when the model fails', async () => {
    const llm = new ScriptedLlm([]);
    const { handler } = await setup({ llm });
    const replier = new FakeReplier();

    await expect(handler.handle(incoming('(choice: day.draft:m1)'), replier)).resolves.toBe('handled');
    expect(replier.replies[0]?.message.text).toContain('초안을 만들지 못했어요');
  });
});

describe('day.replies capability wiring', () => {
  it('does nothing without the awaiting capability', async () => {
    const notifier = new FakeNotifier();
    const context = createTestContext({ now: NOW, capabilities: { [Contracts.notifier.id]: notifier } });
    await daySkill().setup(context.ctx);

    await expect(context.scheduler.run('day.replies', NOW)).resolves.toBeUndefined();
    expect(notifier.notices).toHaveLength(0);
  });

  it('does not warn when the digest has nothing to list', async () => {
    const summaries: MailSummary[] = [];
    const { notifier, scheduler } = await setup({ awaiting: new FakeAwaiting(summaries) });
    await scheduler.run('day.replies', NOW);
    expect(notifier.notices).toHaveLength(0);
  });
});
