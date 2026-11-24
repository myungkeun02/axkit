import { describe, expect, it } from 'vitest';
import type { Bot } from '../../../src/core/contracts/bots.js';
import { mentionSection, mentionedBots } from '../../../src/skills/assistant/bots.js';

const bot = (id: string, name: string, status: Bot['status'] = 'idle') => ({ id, name, role: `${name}의 일`, status }) as Bot;
const BOTS = [bot('qa', 'QA 봇'), bot('qa-review', 'QA 검수'), bot('dev-clipper', 'clipper 개발 봇'), bot('old', '옛 봇', 'off')];

describe('@ to hand a task to a bot from the main chat', () => {
  it('finds tagged bots by name (spaces or not) or id, never a longer id by its prefix, never an off bot', () => {
    expect(mentionedBots('@QA 봇 오늘 업무보드 테스트 해 줘', BOTS).map((item) => item.id)).toEqual(['qa']);
    expect(mentionedBots('@clipper개발봇 업로드 고쳐', BOTS).map((item) => item.id)).toEqual(['dev-clipper']);
    expect(mentionedBots('@qa-review 이거 봐 줘', BOTS).map((item) => item.id)).toEqual(['qa-review']);
    expect(mentionedBots('@옛 봇 해 줘', BOTS)).toEqual([]);
    expect(mentionedBots('메일 a@b.com 확인', BOTS)).toEqual([]);
  });

  it('asks the assistant to write a brief for the tagged bot instead of doing it or forwarding the words', () => {
    const section = mentionSection('@QA 봇 업무보드 테스트', BOTS, true) ?? '';
    expect(section).toContain('qa (QA 봇)');
    expect(section).toContain('bots.delegate');
    expect(section).toContain('다시 쓴 지시서');
    expect(mentionSection('그냥 질문이야', BOTS, true)).toBeUndefined();
  });
});

describe('@ names with spaces, as the apps insert them', () => {
  it('reads "@개발 직원 1 " and a Latin word right after a Korean name, never a longer number', () => {
    const bots = [bot('s1', '개발 직원 1'), bot('s10', '개발 직원 10'), bot('qa', 'QA 봇')];
    expect(mentionedBots('@개발 직원 1 이거 해 줘', bots).map((item) => item.id)).toEqual(['s1']);
    expect(mentionedBots('@개발 직원 10 이거', bots).map((item) => item.id)).toEqual(['s10']);
    expect(mentionedBots('@QA 봇 test 돌려 줘', bots).map((item) => item.id)).toEqual(['qa']);
  });
});
