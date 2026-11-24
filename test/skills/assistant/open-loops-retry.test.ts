import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { QuestionRequest, QuestionResult } from '../../../src/core/policy/questions.js';
import type { OpenItem } from '../../../src/skills/assistant/open-loops.js';
import { OpenLoops } from '../../../src/skills/assistant/open-loops.js';
import { createTestContext } from '../../support/context.js';

const APP = { channelId: 'channel.app', address: 'owner' };
const HOUR_MS = 3_600_000;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function setup() {
  const asked: QuestionRequest[] = [];
  const pending: ((result: QuestionResult) => void)[] = [];
  const context = createTestContext({
    now: new Date('2026-11-23T09:00:00+09:00'),
    capabilities: {
      [Contracts.questions.id]: {
        ask(request: QuestionRequest) {
          asked.push(request);
          return new Promise<QuestionResult>((resolve) => pending.push(resolve));
        },
      },
    },
  });
  const answerNext = async (result: QuestionResult): Promise<void> => {
    pending.shift()?.(result);
    await settle();
  };
  return { context, asked, answerNext };
}

async function stored(loops: OpenLoops, ctx: ReturnType<typeof setup>['context']): Promise<OpenItem[]> {
  await loops.section(true);
  return (await ctx.ctx.kv.get<OpenItem[]>('open-loops')) ?? [];
}

describe('open-loop follow-ups', () => {
  it('shows at most one card per sweep and none while one is still out', async () => {
    const { context, asked, answerNext } = setup();
    const loops = new OpenLoops(context.ctx);
    await loops.add(APP, [
      { text: '워크숍 장소', proposal: '강남 회의실 예약' },
      { text: '휴가 날짜', proposal: '12월 첫 주' },
    ]);
    await context.clock.advance(21 * HOUR_MS);
    expect(await loops.followUp(true)).toBe(1);
    expect(await loops.followUp(true)).toBe(0); // the first card is still waiting
    expect(asked).toHaveLength(1);
    await answerNext({ status: 'answered', choice: 'no', means: 'denied', reused: false });
    expect(await loops.followUp(true)).toBe(1);
    expect(asked.map((request) => request.summary)).toEqual([
      '지난번 "워크숍 장소"은(는) 이렇게 처리할까요?',
      '지난번 "휴가 날짜"은(는) 이렇게 처리할까요?',
    ]);
  });

  it('asks again later after an unanswered card, then gives up after the last one', async () => {
    const { context, asked, answerNext } = setup();
    const loops = new OpenLoops(context.ctx);
    await loops.add(APP, [{ text: '견적 회신', proposal: '초안 쓰기' }]);
    await context.clock.advance(21 * HOUR_MS);
    expect(await loops.followUp(true)).toBe(1);
    await answerNext({ status: 'expired' });
    expect((await stored(loops, context)).map((item) => [item.status, item.asks])).toEqual([['open', 1]]);

    expect(await loops.followUp(true)).toBe(0); // too soon after the last card
    await context.clock.advance(6 * HOUR_MS);
    expect(await loops.followUp(true)).toBe(1);
    await answerNext({ status: 'expired' });
    await context.clock.advance(6 * HOUR_MS);
    expect(await loops.followUp(true)).toBe(1);
    await answerNext({ status: 'expired' });
    expect((await stored(loops, context))[0]?.status).toBe('dropped');
    await context.clock.advance(6 * HOUR_MS);
    expect(await loops.followUp(true)).toBe(0);
    expect(asked).toHaveLength(3);
  });

  it('after a restart, puts items left asked back to open and asks again', async () => {
    const { context, asked } = setup();
    const before = new OpenLoops(context.ctx);
    await before.add(APP, [{ text: '견적 회신', proposal: '초안 쓰기' }]);
    await context.clock.advance(21 * HOUR_MS);
    expect(await before.followUp(true)).toBe(1);
    expect((await context.ctx.kv.get<OpenItem[]>('open-loops'))?.[0]?.status).toBe('asked');

    // the process restarts: the waiter for that card is gone
    const after = new OpenLoops(context.ctx);
    await after.reconcile();
    expect((await context.ctx.kv.get<OpenItem[]>('open-loops'))?.[0]?.status).toBe('open');
    await context.clock.advance(6 * HOUR_MS);
    expect(await after.followUp(true)).toBe(1);
    expect(asked).toHaveLength(2);
  });
});
