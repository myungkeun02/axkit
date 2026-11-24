import { describe, expect, it } from 'vitest';
import type { LlmProvider } from '../../../src/core/llm/types.js';
import { AppActivity, stepLabel } from '../../../src/channels/app/activity.js';
import { assistantSkill } from '../../../src/skills/assistant/plugin.js';
import { routinesSkill } from '../../../src/skills/routines/plugin.js';
import { FakeClock } from '../../core/helpers.js';
import { api, pairApp, startApp } from './harness.js';

const TEMPLATE = 'You are {{persona}}. {{tools}}';
const plan = (reply: string, calls: { name: string; args: Record<string, unknown> }[] = []): string =>
  JSON.stringify({ reply, tool_calls: calls.map((call) => ({ ...call, why: null })), question: null });

function model(): LlmProvider {
  return {
    id: 'fake',
    async complete(_model, request) {
      const last = request.messages.at(-1)?.content ?? '';
      const text = last.includes('tool_results') ? plan('루틴 목록이에요.') : plan('', [{ name: 'routines.list', args: {} }]);
      return { text, providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  };
}

describe('assistant activity hint', () => {
  it('streams thinking, a plain working step and idle around a reply, without tool names', async () => {
    const h = await startApp({ llm: model(), plugins: [assistantSkill({ loadSystemPrompt: async () => TEMPLATE }), routinesSkill()] });
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[] };
      expect(caps.features).toContain('activity');
      const controller = new AbortController();
      const response = await fetch(`${h.base}/m/v1/app/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      const reader = response.body!.getReader();
      let text = '';
      await new Promise((resolve) => setTimeout(resolve, 50));
      await api(h, token, 'messages', { text: '루틴 보여줘' });
      while (!text.includes('"state":"idle"')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      controller.abort();
      const states = [...text.matchAll(/event: activity\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1] ?? '{}') as { state: string; step?: string });
      expect(states.map((s) => s.state)).toEqual(['thinking', 'working', 'idle']);
      expect(states[1]?.step).toBe('루틴 정리하는 중');
      expect(text).not.toContain('routines.list');
      // live only: activity lines carry no id
      expect(text).not.toMatch(/id: \d+\nevent: activity/);
    } finally {
      await h.stop();
    }
  });

  it('keeps rooms apart, shows the busy ones to a new client and forgets a turn that never ended', async () => {
    const clock = new FakeClock(new Date('2026-11-20T03:00:00Z'));
    const activity = new AppActivity('channel.app', clock, true);
    const handlers: ((payload: unknown) => void)[] = [];
    const bus = { on: (_name: string, handler: (payload: unknown) => void) => (handlers.push(handler), () => undefined) };
    activity.attach(bus as never);
    const fire = (address: string, state: string, tool?: string, channelId = 'channel.app'): void => {
      for (const handler of handlers) handler({ conversation: { channelId, address }, state, ...(tool !== undefined ? { tool } : {}) });
    };
    fire('owner', 'thinking');
    fire('bot:dev', 'working', 'web.look');
    fire('dm-1', 'thinking', undefined, 'channel.discord');
    expect(activity.snapshot()).toEqual([
      { type: 'activity', state: 'thinking', at: '2026-11-20T03:00:00.000Z' },
      { type: 'activity', channel: 'dev', state: 'working', step: '웹에서 찾아보는 중', at: '2026-11-20T03:00:00.000Z' },
    ]);
    fire('owner', 'idle');
    expect(activity.snapshot().map((e) => e.channel)).toEqual(['dev']);
    await clock.advance(4 * 60_000);
    expect(activity.snapshot()).toEqual([]);
    expect(stepLabel('something.new', true)).toBe('작업하는 중');
  });
});
