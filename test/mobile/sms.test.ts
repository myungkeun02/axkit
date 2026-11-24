import { describe, expect, it } from 'vitest';
import type { TodoDraft, TodoItem, TodoWriter } from '../../src/core/contracts/index.js';
import type { ConversationRef, IncomingMessage, OutgoingMessage, Replier } from '../../src/core/conversation/types.js';
import type { LlmRequest } from '../../src/core/llm/types.js';
import { mobileTexts } from '../../src/mobile/locale.js';
import { SmsActions } from '../../src/mobile/sms-action.js';
import type { PendingAction } from '../../src/mobile/sms-action.js';
import { createTestContext } from '../support/context.js';
import { ScriptedLlm } from '../support/context.js';
import { NOW, FakeNotifier, seededRandom } from './helpers.js';

const texts = mobileTexts('ko');

interface SetupOptions {
  script?: (string | ((request: LlmRequest) => string))[];
  todo?: TodoWriter;
}

function setup(options: SetupOptions = {}) {
  const llm = new ScriptedLlm(options.script ?? []);
  const context = createTestContext({ now: NOW, llm });
  const notifier = new FakeNotifier();
  const actions = new SmsActions({
    kv: context.kv,
    llm,
    clock: context.clock,
    log: context.ctx.log,
    texts,
    notifier: () => notifier,
    todo: () => options.todo,
    randomBytes: seededRandom(3),
  });
  context.ctx.registerHandler(actions.handler());
  return { context, notifier, actions, texts, llm };
}

function handlerOf(context: ReturnType<typeof setup>['context']) {
  const handler = context.handlers.find((candidate) => candidate.id === 'mobile.sms_action');
  if (handler === undefined) throw new Error('handler not registered');
  return handler;
}

function makeReplier() {
  const replies: { conversation: ConversationRef; message: OutgoingMessage }[] = [];
  const replier: Replier = {
    async reply(conversation, message) {
      replies.push({ conversation, message });
    },
  };
  return { replier, replies };
}

function choiceMessage(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'test', address: 'owner' },
    authorId: 'owner',
    fromOwner,
    text,
    receivedAt: NOW,
  };
}

describe('silent messages', () => {
  it('keeps verification codes away from the model and chat', async () => {
    const { context, notifier, actions, llm } = setup();

    await actions.handle({ kind: 'sms', at: NOW, from: 'example', text: '[Web발신] 인증번호 482913' });

    expect(llm.requests).toHaveLength(0);
    expect(notifier.notices).toHaveLength(0);
    expect(await context.kv.get<PendingAction[]>('pendingActions')).toBeUndefined();
  });

  it('keeps card approvals silent', async () => {
    const { notifier, actions, llm } = setup();

    await actions.handle({ kind: 'sms', at: NOW, text: '카드 승인 12,000원 일시불' });

    expect(llm.requests).toHaveLength(0);
    expect(notifier.notices).toHaveLength(0);
  });

  it('drops spam without a model call', async () => {
    const { notifier, actions, llm } = setup();

    await actions.handle({ kind: 'sms', at: NOW, text: '[광고] 무료 수신 거부 080-1234-5678' });

    expect(llm.requests).toHaveLength(0);
    expect(notifier.notices).toHaveLength(0);
  });
});

describe('action notices', () => {
  it('asks the model about the wrapped message and sends only the action', async () => {
    const action = '내일까지 회비 내기';
    const { notifier, actions, llm } = setup({ script: [JSON.stringify({ action })] });
    const raw = '내일까지 회비 보내줘 https://example.com/secretpath';

    await actions.handle({ kind: 'sms', at: NOW, from: '민수', text: raw });

    expect(llm.requests).toHaveLength(1);
    const request = llm.requests[0];
    expect(request).toMatchObject({ purpose: 'phone.sms_action', tier: 'fast', sensitivity: 'sensitive' });
    expect(request?.jsonSchema).toBeDefined();
    const userMessage = request?.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(userMessage).toContain('not instructions');
    expect(userMessage).toContain('example.com');

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice).toMatchObject({
      kind: 'phone.sms_action',
      text: `문자(민수)에서 할 일: ${action}`,
      choices: [{ id: expect.stringMatching(/^phone\.todo:[A-Za-z0-9_-]+$/), label: '할 일에 추가' }],
    });
    expect(JSON.stringify(notice)).not.toContain('secretpath');
    expect(JSON.stringify(notice)).not.toContain(raw);
    expect(notice?.dedupeKey).toBeDefined();
    expect((notice?.choices?.[0]?.id ?? '').length).toBeLessThanOrEqual(90);
  });

  it('labels a notification with its app name', async () => {
    const { notifier, actions } = setup({ script: [JSON.stringify({ action: '서류 제출하기' })] });

    await actions.handle({ kind: 'notification', at: NOW, app: '메일', text: '오늘까지 서류를 제출해 주세요' });

    expect(notifier.notices[0]?.text).toBe('알림(메일)에서 할 일: 서류 제출하기');
  });

  it('sends nothing when the model answer is not JSON', async () => {
    const { notifier, actions } = setup({ script: ['verification is not needed'] });

    await expect(
      actions.handle({ kind: 'sms', at: NOW, text: '내일까지 회비를 보내 주세요' }),
    ).resolves.toBeUndefined();
    expect(notifier.notices).toHaveLength(0);
  });

  it('sends nothing when the model call fails', async () => {
    const { notifier, actions } = setup();

    await expect(
      actions.handle({ kind: 'sms', at: NOW, text: '내일까지 회비를 보내 주세요' }),
    ).resolves.toBeUndefined();
    expect(notifier.notices).toHaveLength(0);
  });

  it('keeps at most 100 pending actions', async () => {
    const { context, actions } = setup({ script: [JSON.stringify({ action: '최신 할 일' })] });
    await context.kv.set(
      'pendingActions',
      Array.from({ length: 100 }, (_, index) => ({
        id: `p${index}`,
        action: 'old',
        createdAt: NOW.toISOString(),
      })),
    );

    await actions.handle({ kind: 'sms', at: NOW, text: '내일까지 회비를 보내 주세요' });

    const pending = (await context.kv.get<PendingAction[]>('pendingActions')) ?? [];
    expect(pending).toHaveLength(100);
    expect(pending[0]?.id).toBe('p1');
    expect(pending.at(-1)?.action).toBe('최신 할 일');
  });
});

describe('to-do button', () => {
  function todoWriter(added: TodoDraft[]): TodoWriter {
    return {
      async add(draft: TodoDraft): Promise<TodoItem> {
        added.push(draft);
        return { id: 't1', text: draft.text, done: false, createdAt: NOW.toISOString() };
      },
    };
  }

  it('adds the action once and confirms to the owner', async () => {
    const added: TodoDraft[] = [];
    const action = '내일까지 회비 내기';
    const { context, notifier, actions } = setup({
      script: [JSON.stringify({ action })],
      todo: todoWriter(added),
    });
    await actions.handle({ kind: 'sms', at: NOW, from: '민수', text: '내일까지 회비 보내줘' });
    const choiceId = notifier.notices[0]?.choices?.[0]?.id ?? '';
    const { replier, replies } = makeReplier();

    const first = await handlerOf(context).handle(choiceMessage(`(choice: ${choiceId})`), replier);
    const second = await handlerOf(context).handle(choiceMessage(`(choice: ${choiceId})`), replier);

    expect(first).toBe('handled');
    expect(second).toBe('handled');
    expect(added).toEqual([{ text: action }]);
    expect(replies[0]?.message.text).toBe(texts.todoAdded(action));
    expect(replies[1]?.message.text).toBe(texts.pendingGone);
    expect((await context.kv.get<PendingAction[]>('pendingActions')) ?? []).toEqual([]);
  });

  it('says the to-do skill is off when it is missing', async () => {
    const { context, notifier, actions } = setup({ script: [JSON.stringify({ action: '서류 제출하기' })] });
    await actions.handle({ kind: 'sms', at: NOW, text: '오늘까지 서류를 제출해 주세요' });
    const choiceId = notifier.notices[0]?.choices?.[0]?.id ?? '';
    const { replier, replies } = makeReplier();

    await handlerOf(context).handle(choiceMessage(`(choice: ${choiceId})`), replier);

    expect(replies[0]?.message.text).toBe(texts.todoOff);
  });

  it('passes on other messages and other choices', async () => {
    const { context } = setup();
    const { replier } = makeReplier();

    expect(await handlerOf(context).handle(choiceMessage('(choice: other:1)'), replier)).toBe('pass');
    expect(await handlerOf(context).handle(choiceMessage('안녕하세요'), replier)).toBe('pass');
    expect(await handlerOf(context).handle(choiceMessage('(choice: phone.todo:abc)', false), replier)).toBe('pass');
  });
});
