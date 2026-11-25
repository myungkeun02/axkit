import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { OrgUnit, RoutineProposal } from '../../../src/core/contracts/index.js';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import type { QuestionRequest } from '../../../src/core/policy/questions.js';
import { TeamPlanFlow } from '../../../src/skills/assistant/team-plan-flow.js';
import { placeRoutines, unitTeams } from '../../../src/skills/assistant/team-plan-units.js';
import { planText, readPlan } from '../../../src/skills/assistant/team-plan.js';
import { createTestContext } from '../../support/context.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const AT = '2026-11-23T00:00:00.000Z';
const UNITS: OrgUnit[] = [
  { org: '에이컴퍼니', name: '사업본부', lead: '정대표', members: ['정대표'], sources: ['조직도'] },
  { org: '에이컴퍼니', name: '마케팅팀', parent: '사업본부', purpose: '브랜드와 광고', lead: '김민수', members: ['김민수', '이지은'], sources: ['조직도'], roles: [{ title: '광고 리포트', does: '광고 성과를 모아요' }] },
  { org: '에이컴퍼니', name: '개발팀', parent: '사업본부', lead: '박준호', members: ['박준호', '최서연'], sources: ['조직도'], kind: 'dev' },
];
const ROUTINES: RoutineProposal[] = [
  { title: '주간 회의 준비', instruction: '안건을 모아 줘', schedule: { kind: 'weekly', day: 'mon', at: '10:00' }, team: '마케팅팀', company: '에이컴퍼니', evidence: ["캘린더 '마케팅 주간 회의' 12번 · 매주 월 10:00"] },
  { title: '월말 결산 초안', instruction: '이번 달 결산 초안을 만들어 줘', schedule: { kind: 'monthly', day: -1, at: '09:00' }, evidence: ["문서 '월말 결산' 등 6개 · 매월 말일 새로 만들어짐"] },
];

const noModel = { async complete() { throw new Error('no model'); } } as unknown as LlmGateway;

function setup() {
  const asked: QuestionRequest[] = [];
  const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date(AT));
  const context = createTestContext({
    now: new Date(AT),
    llm: noModel,
    capabilities: { [Contracts.questions.id]: { ask: async (request: QuestionRequest) => (asked.push(request), { status: 'answered', choice: 'build', means: 'approved', reused: false }) } },
  });
  const routines: Record<string, unknown>[] = [];
  context.ctx.registerTool({ name: 'routines.add', description: 'fake', input: z.record(z.string(), z.unknown()), effects: ['write'], run: async (input) => (routines.push(input), { id: 'r1' }) });
  const flow = new TeamPlanFlow({ ctx: context.ctx, korean: true, directory: () => directory, refine: () => undefined });
  return { context, flow, directory, asked, routines };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('teams from the real organisation', () => {
  it('makes one team per unit with its lead and members, leaving a one-person parent unit to its children', () => {
    const teams = unitTeams(UNITS);
    expect(teams.map((team) => [team.name, team.kind, team.unit])).toEqual([
      ['마케팅팀', 'general', { parent: '사업본부', lead: '김민수', members: ['김민수', '이지은'] }],
      ['개발팀', 'dev', { parent: '사업본부', lead: '박준호', members: ['박준호', '최서연'] }],
    ]);
    expect(teams[0]?.roles).toEqual([{ title: '광고 리포트', does: '광고 성과를 모아요' }]);
  });

  it('gives routines to their team and the rest to the assistant', () => {
    const teams = unitTeams(UNITS);
    const own = placeRoutines(teams, ROUTINES);
    expect(teams[0]?.routines.map((routine) => routine.title)).toEqual(['주간 회의 준비']);
    expect(own.map((routine) => routine.title)).toEqual(['월말 결산 초안']);
  });

  it('proposes units and evidence routines on one card, builds them on yes, and asks nothing new for the same scan', async () => {
    const { context, flow, directory, asked, routines } = setup();
    expect(await flow.propose({ projects: [], units: UNITS, routines: ROUTINES })).toBe(true);
    await settle();
    const note = asked[0]?.note ?? '';
    expect(note).toContain('■ 에이컴퍼니\n  · 마케팅팀 [리드 김민수, 2명] — 광고 리포트\n      ↻ 매주 월 10:00 주간 회의 준비\n        근거: 캘린더');
    expect(note).toContain('■ 비서가 직접\n      ↻ 매월 말일 09:00 월말 결산 초안');
    expect((await directory.teams()).map((team) => team.name)).toEqual(['마케팅팀', '개발팀']);
    expect(routines).toHaveLength(2);
    expect(routines[1]).toEqual({ title: '월말 결산 초안', instruction: '이번 달 결산 초안을 만들어 줘', schedule: { kind: 'monthly', day: -1, at: '09:00' } });
    expect((await readPlan(context.kv))?.status).toBe('applied');

    expect(await flow.propose({ projects: [], units: UNITS, routines: ROUTINES })).toBe(true);
    await settle();
    expect(asked).toHaveLength(1);
  });

  it('updates a plan still waiting for an answer instead of sending a second card', async () => {
    const { context, flow, asked } = setup();
    const waiting = { id: 'p1', createdAt: AT, status: 'proposed' as const, teams: [], routines: [] };
    await context.kv.set('team-plan', waiting);
    await flow.propose({ projects: [], units: UNITS, routines: ROUTINES });
    const plan = await readPlan(context.kv);
    expect(plan?.id).toBe('p1');
    expect(plan?.teams).toHaveLength(2);
    expect(asked).toHaveLength(0);
    expect(planText(plan!, true)).toContain('개발팀 (개발·검수 포함) [리드 박준호, 2명]');
  });
});
