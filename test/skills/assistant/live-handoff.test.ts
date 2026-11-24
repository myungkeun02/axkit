import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { ToolRunContext } from '../../../src/core/tools/types.js';
import { liveHandoffOf } from '../../../src/skills/assistant/live.js';
import { makeHarness, plan, run } from './helpers.js';

function handoffTool(output: unknown, seen: ToolRunContext['call'][]) {
  return {
    name: 'browser.fake',
    description: 'A browser errand.',
    input: z.object({}),
    effects: ['read'] as const,
    run: async (_input: unknown, ctx: ToolRunContext) => {
      seen.push(ctx.call);
      return output;
    },
  };
}

describe('live handoff on the reply (§22)', () => {
  it('reads the browser outputs convention and ignores anything else', () => {
    expect(liveHandoffOf({ status: 'needs_human', url: 'https://shop.example.com/login', handoff: { reason: 'login' }, liveView: 'browser-live' })).toEqual({
      view: 'browser-live',
      reason: 'login',
      url: 'https://shop.example.com/login',
    });
    expect(liveHandoffOf({ status: 'opened', liveView: 'browser-live', url: 'javascript:alert(1)', handoff: { reason: 'weird' } })).toEqual({
      view: 'browser-live',
      reason: 'other',
    });
    expect(liveHandoffOf({ status: 'needs_human', url: 'https://x.example/' })).toBeUndefined();
    expect(liveHandoffOf('browser-live')).toBeUndefined();
    expect(liveHandoffOf(null)).toBeUndefined();
  });

  it('puts `live` on the reply when a tool this turn left a page, and hands tools the conversation', async () => {
    const seen: ToolRunContext['call'][] = [];
    const harness = await makeHarness({
      script: [plan('', [{ name: 'browser.fake', args: {} }]), plan('로그인 화면에서 멈췄어요.')],
    });
    harness.ctx.registerTool(
      handoffTool({ status: 'needs_human', url: 'https://shop.example.com/login', handoff: { reason: 'login' }, liveView: 'browser-live' }, seen),
    );
    const { replies } = await run(harness.handler, '쇼핑몰 주문 내역 봐 줘', { conversation: { channelId: 'channel.discord', address: 'dm-1', replyTo: 'm1' } });
    expect(replies).toEqual([
      { text: '로그인 화면에서 멈췄어요.', live: { view: 'browser-live', reason: 'login', url: 'https://shop.example.com/login' } },
    ]);
    expect(seen[0]?.conversation).toEqual({ channelId: 'channel.discord', address: 'dm-1', replyTo: 'm1' });
  });

  it('leaves the reply plain when no tool left a page', async () => {
    const harness = await makeHarness({ script: [plan('', [{ name: 'browser.fake', args: {} }]), plan('다 읽었어요.')] });
    harness.ctx.registerTool(handoffTool({ status: 'done', text: '주문 2건' }, []));
    const { replies } = await run(harness.handler, '주문 내역 봐 줘');
    expect(replies).toEqual([{ text: '다 읽었어요.' }]);
  });
});
