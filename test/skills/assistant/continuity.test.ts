import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { IncomingMessage } from '../../../src/core/conversation/types.js';
import type { QuestionRequest, QuestionResult } from '../../../src/core/policy/questions.js';
import { Continuity } from '../../../src/skills/assistant/continuity.js';
import { parsePlan } from '../../../src/skills/assistant/plan.js';
import { createTestContext } from '../../support/context.js';

const APP = { channelId: 'channel.app', address: 'owner' };
const DISCORD = { channelId: 'channel.discord', address: 'dm-1' };

function message(text: string, conversation = APP): IncomingMessage {
  return { id: `m-${text}`, conversation, authorId: 'owner', fromOwner: true, text, receivedAt: new Date() };
}

function setup(answer: QuestionResult) {
  const asked: QuestionRequest[] = [];
  const remembered: string[] = [];
  const context = createTestContext({
    now: new Date('2026-11-23T09:00:00+09:00'),
    capabilities: {
      [Contracts.questions.id]: {
        async ask(request: QuestionRequest) {
          asked.push(request);
          return answer;
        },
      },
      [Contracts.memoryWrite.id]: {
        async remember(input: { text: string }) {
          remembered.push(input.text);
          return { id: 'f', subject: 'owner', text: input.text, source: { kind: 'chat' }, at: '' };
        },
      },
    },
  });
  const received: IncomingMessage[] = [];
  context.bus.on('message.received', (incoming) => void received.push(incoming));
  return { context, continuity: new Continuity(context.ctx, true), asked, remembered, received };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('one assistant across chats', () => {
  it('reads notes leniently: a broken notes block never costs the reply', () => {
    const ok = parsePlan(JSON.stringify({ reply: '네', tool_calls: [], question: null, notes: { remember: ['오전 통화 선호'], open: [{ text: '견적 보낼지', proposal: '내일 보내기' }], resolved: [] } }));
    expect('plan' in ok && ok.plan.notes?.open[0]?.proposal).toBe('내일 보내기');
    const broken = parsePlan(JSON.stringify({ reply: '네', tool_calls: [], question: null, notes: 'oops' }));
    expect('plan' in broken && broken.plan.reply).toBe('네');
  });

  it('remembers what the turn noted and shows other chats’ recent exchanges', async () => {
    const { context, continuity, remembered } = setup({ status: 'expired' });
    await continuity.notes(message('나 오전엔 통화 안 돼'), { remember: ['오전에는 통화가 어려움', 'x'], open: [], resolved: [] });
    expect(remembered).toEqual(['오전에는 통화가 어려움']);
    await continuity.record(message('견적서 어디까지 됐지?', DISCORD), '초안까지 썼어요.');
    const sections = await continuity.sections(message('그거 보내 줘'));
    expect(sections[0]).toContain('[디스코드] 오너: 견적서 어디까지 됐지? / 비서: 초안까지 썼어요.');
    // its own conversation is not repeated back
    expect((await continuity.sections(message('또', DISCORD))).join('')).not.toContain('견적서 어디까지');
    void context;
  });

  it('asks once about something left undecided, does it on yes and never asks again', async () => {
    const { context, continuity, asked, received } = setup({ status: 'answered', choice: 'yes', means: 'approved', reused: false });
    await continuity.notes(message('견적은 좀 생각해 볼게'), { remember: [], open: [{ text: '거래처 견적 회신', proposal: '지난주 단가로 회신 초안을 써 둘게요' }], resolved: [] });
    expect((await continuity.sections(message('다른 얘기')))[0]).toMatch(/- o[0-9a-f]{6}: 거래처 견적 회신 → 제안: 지난주 단가로 회신 초안을 써 둘게요/);

    expect(await continuity.loops.followUp(true)).toBe(0); // not quiet for a day yet
    await context.clock.advance(21 * 60 * 60 * 1000);
    expect(await continuity.loops.followUp(true)).toBe(1);
    await settle();
    expect(asked.map((request) => request.summary)).toEqual(['지난번 "거래처 견적 회신"은(는) 이렇게 처리할까요?']);
    expect(received.map((incoming) => [incoming.conversation, incoming.text, incoming.fromOwner])).toEqual([[{ ...APP, thread: 'owner' }, '(지난번 "거래처 견적 회신") 제안대로 처리해 줘: 지난주 단가로 회신 초안을 써 둘게요', true]]);

    await context.clock.advance(48 * 60 * 60 * 1000);
    expect(await continuity.loops.followUp(true)).toBe(0);
    expect(asked).toHaveLength(1);
    expect(await continuity.sections(message('다른 얘기'))).toEqual(expect.not.arrayContaining([expect.stringContaining('거래처 견적')]));
  });

  it('lets it go after "leave it" or no answer, and drops it when settled in chat', async () => {
    const { context, continuity, asked, received } = setup({ status: 'answered', choice: 'no', means: 'denied', reused: false });
    await continuity.notes(message('a'), { remember: [], open: [{ text: '워크숍 장소', proposal: '강남 회의실 예약' }, { text: '휴가 날짜', proposal: '12월 첫 주로 잡기' }], resolved: [] });
    const section = (await continuity.sections(message('b')))[0] ?? '';
    const vacation = /- (o[0-9a-f]{6}): 휴가 날짜/.exec(section)?.[1] ?? '';
    await continuity.notes(message('휴가는 12월 둘째 주로 할게'), { remember: [], open: [], resolved: [vacation] });
    await context.clock.advance(21 * 60 * 60 * 1000);
    expect(await continuity.loops.followUp(true)).toBe(1);
    await settle();
    expect(asked.map((request) => request.topic.startsWith('assistant:open:'))).toEqual([true]);
    expect(received).toEqual([]);
    expect(await continuity.loops.followUp(true)).toBe(0);
  });
});
