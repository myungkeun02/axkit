import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import type { Bot, BotTeam } from '../../../src/core/contracts/bots.js';
import type { OutgoingMessage } from '../../../src/core/conversation/types.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import { assistantSkill } from '../../../src/skills/assistant/plugin.js';
import { runTeam } from '../../../src/skills/assistant/team-run.js';
import type { BotReply } from '../../../src/skills/assistant/team-run.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { ScriptedLlm, createTestContext } from '../../support/context.js';
import { TEMPLATE, plan } from './helpers.js';

const LIVE = { view: 'browser-live', reason: 'login', url: 'https://shop.example.com/login' } as const;
const TEAM: BotTeam = { id: 'team-shop', group: 'home', name: 'Shop', kind: 'general', tiers: { lead: 'A', staff: 'B' }, lead: 'shop-lead', createdAt: '2026-11-19T00:00:00Z' };

function member(id: string, rank: Bot['rank']): Bot {
  return { id, name: id, role: '쇼핑', kind: 'general', status: 'idle', origin: 'owner', rank, team: TEAM.id, createdAt: '2026-11-19T00:00:00Z' } as Bot;
}

const assign = (staff: number[]) => JSON.stringify({ assignments: staff.map((n) => ({ staff: n, task: `일 ${n}`, say: `${n}번 부탁해요.` })) });

describe('members build on each other', () => {
  it('gives each member the owner task, its part, the earlier results and a nudge to use its tools', async () => {
    const llm = new ScriptedLlm([assign([1, 2]), '정리했어요.']);
    const asked: string[] = [];
    const answers = [{ text: '메일 목록: 1) 김민수 견적 문의 2) 이지은 일정 문의' }, { text: '분류: 견적 1, 일정 1' }];
    await runTeam(
      { ctx: { llm } as unknown as PluginContext, korean: true, runAs: async (_bot, text) => (asked.push(text), answers.shift() ?? { text: '' }), say: async () => undefined },
      TEAM,
      [member('shop-lead', 'lead'), member('shop-s1', 'staff'), member('shop-s2', 'staff')],
      '받은 메일 정리해 줘',
    );
    expect(asked[0]).toContain('오너가 팀에 맡긴 일: 받은 메일 정리해 줘');
    expect(asked[0]).toContain('도구로 직접');
    expect(asked[0]).not.toContain('앞 사람들이 넘긴 결과');
    expect(asked[1]).toContain('앞 사람들이 넘긴 결과:\nshop-s1: 메일 목록: 1) 김민수 견적 문의');
    expect(llm.requests[0]?.messages[0]?.content).toContain('each sees what the earlier ones handed back');
  });
});

describe('team replies carry `live` (§22)', () => {
  it('passes the last page a member left up to the lead’s answer', async () => {
    const llm = new ScriptedLlm([assign([1, 2]), '로그인에서 멈췄어요. 앱에서 이어 주세요.']);
    const ctx = { llm } as unknown as PluginContext;
    const answers: BotReply[] = [{ text: '로그인 화면이에요.', live: LIVE }, { text: '정리했어요.' }];
    const reply = await runTeam(
      { ctx, korean: true, runAs: async () => answers.shift() ?? { text: '' }, say: async () => undefined },
      TEAM,
      [member('shop-lead', 'lead'), member('shop-s1', 'staff'), member('shop-s2', 'staff')],
      '주문 내역 봐 줘',
    );
    expect(reply).toEqual({ text: '로그인에서 멈췄어요. 앱에서 이어 주세요.', live: LIVE, status: { state: 'completed' } });
  });

  it('stays text only when nobody left a page, and passes the lead’s own page when it works alone', async () => {
    const bots = [member('shop-lead', 'lead'), member('shop-s1', 'staff')];
    const plain = await runTeam(
      { ctx: { llm: new ScriptedLlm([assign([1]), '끝났어요.']) } as unknown as PluginContext, korean: true, runAs: async () => ({ text: '했어요.' }), say: async () => undefined },
      TEAM,
      bots,
      'x',
    );
    expect(plain).toEqual({ text: '끝났어요.', status: { state: 'completed' } });
    const alone = await runTeam(
      { ctx: { llm: new ScriptedLlm([assign([])]) } as unknown as PluginContext, korean: true, runAs: async () => ({ text: '멈췄어요.', live: LIVE }), say: async () => undefined },
      TEAM,
      bots,
      'x',
    );
    expect(alone).toEqual({ text: '멈췄어요.', live: LIVE });
  });

  it('puts it on the reply in the team room', async () => {
    const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date('2026-11-19T00:00:00Z'));
    await directory.upsertTeam(TEAM);
    for (const bot of [member('shop-lead', 'lead'), member('shop-s1', 'staff')]) await directory.upsert(bot);
    const llm = new ScriptedLlm([
      assign([1]),
      plan('', [{ name: 'browser.fake', args: {} }]),
      plan('로그인 화면에서 멈췄어요.'),
      '로그인에서 멈췄어요. 앱의 브라우저 화면에서 이어 주세요.',
    ]);
    const test = createTestContext({ llm, capabilities: { 'bots.directory': directory } });
    await assistantSkill({ loadSystemPrompt: async () => TEMPLATE }).setup(test.ctx);
    test.ctx.registerTool({
      name: 'browser.fake',
      description: 'A browser errand.',
      input: z.object({}),
      effects: ['read'],
      run: async () => ({ status: 'needs_human', url: LIVE.url, handoff: { reason: 'login' }, liveView: 'browser-live' }),
    });
    const replies: OutgoingMessage[] = [];
    const handler = test.handlers[0];
    await handler?.handle(
      { id: 'm1', conversation: { channelId: 'channel.app', address: 'bot:team-shop' }, authorId: 'owner', fromOwner: true, text: '주문 내역 봐 줘', receivedAt: new Date() },
      { reply: async (_to, message) => void replies.push(message) },
    );
    expect(replies).toEqual([{ text: '로그인에서 멈췄어요. 앱의 브라우저 화면에서 이어 주세요.', live: LIVE }]);
  });
});
