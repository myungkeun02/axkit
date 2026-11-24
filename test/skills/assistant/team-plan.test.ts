import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { AppView } from '../../../src/core/contracts/device-api.js';
import type { KnowledgeLine } from '../../../src/core/contracts/knowledge.js';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import type { QuestionRequest, QuestionResult } from '../../../src/core/policy/questions.js';
import { TeamPlanFlow } from '../../../src/skills/assistant/team-plan-flow.js';
import { readPlan } from '../../../src/skills/assistant/team-plan.js';
import { createTestContext } from '../../support/context.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const AT = '2026-11-23T00:00:00.000Z';
const line = (topic: string, key: string, text: string): KnowledgeLine => ({ area: 'project', topic, key, text, sources: [], at: AT });

const SCAN = {
  projects: [
    line('브랜드A 리뉴얼', 'company', '스튜디오 오름'),
    line('브랜드A 리뉴얼', 'kind', 'general'),
    line('브랜드A 리뉴얼', 'purpose', '로고·가이드 개편'),
    line('브랜드A 리뉴얼', 'tasks', '주간 시안 진행 점검'),
    line('브랜드A 리뉴얼', 'role', '레퍼런스 조사 — 비슷한 사례를 모아요'),
    line('브랜드A 리뉴얼', 'role-2', '피드백 정리 — 고객 피드백을 정리해요'),
    line('전시 포스터', 'company', '스튜디오 오름'),
    line('전시 포스터', 'kind', 'general'),
    line('전시 포스터', 'role', '일정 관리 — 인쇄 일정을 챙겨요'),
  ],
};

function routinesModel(): LlmGateway {
  return {
    async complete() {
      return {
        text: JSON.stringify({ routines: [{ team: 'T1', title: '시안 진행 점검', instruction: '이번 주 시안 진행 상황을 정리해 알려 줘', schedule: { kind: 'weekly', day: 'mon', at: '09:30' } }, { team: 'T9', title: 'x', instruction: 'y', schedule: { kind: 'daily', at: '09:00' } }] }),
        providerId: 'fake',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      };
    },
  } as LlmGateway;
}

function setup(answer: QuestionResult) {
  const asked: QuestionRequest[] = [];
  const notices: string[] = [];
  let view: AppView | undefined;
  const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date(AT));
  const context = createTestContext({
    now: new Date(AT),
    llm: routinesModel(),
    capabilities: {
      [Contracts.questions.id]: { ask: async (request: QuestionRequest) => (asked.push(request), answer) },
      [Contracts.notifier.id]: { notify: async (notice: { text: string }) => void notices.push(notice.text) },
      [Contracts.appViews.id]: { register: (registered: AppView) => (view = registered), addFeature: () => undefined },
    },
  });
  const routines: Record<string, unknown>[] = [];
  context.ctx.registerTool({ name: 'routines.add', description: 'fake', input: z.record(z.string(), z.unknown()), effects: ['write'], run: async (input) => (routines.push(input), { id: 'r1' }) });
  const refined: string[] = [];
  const flow = new TeamPlanFlow({ ctx: context.ctx, korean: true, directory: () => directory, refine: (team) => void refined.push(team.name) });
  flow.registerView();
  return { context, flow, directory, asked, notices, routines, refined, view: async () => (await context.bus.emit('app.started', {} as never), view) };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('team plan from the work map', () => {
  it('shows the structure with routines on one card and builds it all on "이대로 만들기"', async () => {
    const { context, flow, directory, asked, notices, routines, refined } = setup({ status: 'answered', choice: 'build', means: 'approved', reused: false });
    expect(await flow.propose(SCAN)).toBe(true);
    await settle();
    expect(asked[0]?.summary).toBe('일 지도대로 이렇게 팀을 만들까요?');
    // "edit" is the app card's own reserved answer (it closes the card as denied): never a choice id here
    expect(asked[0]?.choices.map((choice) => choice.id)).toEqual(['build', 'fix-in-app', 'no']);
    expect(asked[0]?.note).toContain('■ 스튜디오 오름\n  · 브랜드A 리뉴얼 — 레퍼런스 조사, 피드백 정리\n      ↻ 매주 월 09:30 시안 진행 점검\n  · 전시 포스터 — 일정 관리');
    const teams = await directory.teams();
    expect(teams.map((team) => team.name)).toEqual(['브랜드A 리뉴얼', '전시 포스터']);
    expect(routines).toEqual([{ title: '시안 진행 점검', instruction: '이번 주 시안 진행 상황을 정리해 알려 줘', schedule: { kind: 'weekly', day: 'mon', at: '09:30' }, bot: teams[0]?.lead }]);
    expect(refined).toEqual(['브랜드A 리뉴얼', '전시 포스터']);
    expect(notices).toEqual(['팀 2개와 루틴 1개를 만들었어요. 봇 목록에서 볼 수 있어요.']);
    expect((await readPlan(context.kv))?.status).toBe('applied');
  });

  it('waits on "앱에서 고칠게요", takes the app’s edits and builds what was edited', async () => {
    const { context, flow, directory, routines, view } = setup({ status: 'answered', choice: 'fix-in-app', means: 'later', reused: false });
    await flow.propose(SCAN);
    await settle();
    expect(await directory.teams()).toEqual([]);
    const screen = await view();
    const read = (await screen?.read(new URLSearchParams())) as { plan: { teams: { name: string; roles: { title: string; does: string }[]; routines: unknown[] }[] } };
    const teams = read.plan.teams.map((team, index) => (index === 0 ? { ...team, name: '브랜드A', roles: [{ title: '시안 비교', does: '시안을 비교표로 만들어요' }], routines: [] } : team));
    expect(await screen?.actions?.['save']?.({ teams })).toEqual({ saved: 2 });
    expect(await screen?.actions?.['apply']?.({})).toEqual({ teams: 2, routines: 0 });
    const staff = (await directory.list()).filter((bot) => bot.rank === 'staff').map((bot) => bot.name);
    expect(staff).toContain('브랜드A 시안 비교');
    expect(routines).toEqual([]);
    await expect(screen?.actions?.['save']?.({ teams })).rejects.toThrow('no proposed plan');
    void context;
  });

  it('drops the plan on "만들지 않기" and leaves scans without a hierarchy to the old path', async () => {
    const { context, flow, directory } = setup({ status: 'answered', choice: 'no', means: 'denied', reused: false });
    expect(await flow.propose({ projects: [line('x', 'purpose', 'y')] })).toBe(false);
    await flow.propose(SCAN);
    await settle();
    expect((await readPlan(context.kv))?.status).toBe('declined');
    expect(await directory.teams()).toEqual([]);
  });
});
