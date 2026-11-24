import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { AppView } from '../../../src/core/contracts/device-api.js';
import type { FirstLookProgress } from '../../../src/core/contracts/first-look.js';
import type { KnowledgeLine } from '../../../src/core/contracts/knowledge.js';
import { lineId } from '../../../src/core/text/line-id.js';
import { FirstLookFlow } from '../../../src/skills/assistant/first-look.js';
import type { FirstLookResult } from '../../../src/skills/assistant/first-look.js';
import { TeamPlanFlow } from '../../../src/skills/assistant/team-plan-flow.js';
import { readPlan } from '../../../src/skills/assistant/team-plan.js';
import { applyEdits } from '../../../src/skills/assistant/team-plan-edits.js';
import { ScriptedLlm, createTestContext } from '../../support/context.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const AT = '2026-11-23T00:00:00.000Z';
const line = (topic: string, key: string, text: string, area = 'project'): KnowledgeLine => ({ area, topic, key, text, sources: [], at: AT });

const PROJECTS = [
  line('BetaLab', 'company', 'ACME'),
  line('BetaLab', 'kind', 'dev'),
  line('BetaLab', 'purpose', '학습 플랫폼'),
  line('BetaLab', 'role', '개발 — 기능을 만들어요'),
  line('clipper', 'company', 'ACME'),
  line('clipper', 'kind', 'general'),
  line('clipper', 'purpose', '감사 대응'),
  line('clipper', 'tasks', '주간 감사 일정 점검'),
  line('커뮤니티', 'company', 'ACME'),
  line('커뮤니티', 'kind', 'general'),
];
const PROFILE = [
  line('role', 'occupation', '개발자 겸 운영자 — ACME 커뮤니티를 운영하고 교육 서비스를 만들어요', 'profile'),
  line('org', 'ACME', 'ACME (내 사업): BetaLab, clipper, 커뮤니티', 'profile'),
];

const ROUTINES = JSON.stringify({ routines: [{ team: 'T1', title: '감사 일정 점검', instruction: '이번 주 감사 일정을 정리해 줘', schedule: { kind: 'weekly', day: 'mon', at: '09:00' } }] });

function setup(script: string[], progress?: FirstLookProgress) {
  const llm = new ScriptedLlm([ROUTINES, ...script]);
  const corrected: { id: string; text: string | undefined }[] = [];
  let view: AppView | undefined;
  const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date(AT));
  const context = createTestContext({
    now: new Date(AT),
    llm,
    capabilities: {
      [Contracts.appViews.id]: { register: (registered: AppView) => void (registered.name === 'first-look' ? (view = registered) : undefined), addFeature: () => undefined },
      [Contracts.knowledgeWrite.id]: { replaceScan: async () => ({ added: 0, retired: 0 }), correct: async (id: string, text: string | undefined) => void corrected.push({ id, text }) },
      ...(progress !== undefined ? { [Contracts.firstLook.id]: { progress: () => progress, start: () => 'started' } } : {}),
    },
  });
  context.ctx.registerTool({ name: 'routines.add', description: 'fake', input: z.record(z.string(), z.unknown()), effects: ['write'], run: async () => ({ id: 'r1' }) });
  const plans = new TeamPlanFlow({ ctx: context.ctx, korean: true, directory: () => directory, refine: () => undefined });
  plans.registerView();
  const flow = new FirstLookFlow({ ctx: context.ctx, korean: true, plans });
  flow.register({ tool: true });
  const scanned = async (): Promise<void> => {
    await context.bus.emit('knowledge.scanned', { profile: PROFILE, projects: PROJECTS });
    await plans.propose({ projects: PROJECTS });
  };
  return { context, llm, flow, plans, directory, corrected, scanned, view: async () => (await context.bus.emit('app.started', {} as never), view) };
}

const names = (result: FirstLookResult) => result.companies.map((company) => `${company.name}: ${company.projects.map((project) => project.name).join(', ')}`);

const DONE: FirstLookProgress = {
  status: 'done',
  phase: 'done',
  phases: [{ id: 'local', label: '폴더 파일', done: 400, total: 400, state: 'done' }],
  counts: { files: 400 },
  percent: 100,
  startedAt: AT,
  finishedAt: AT,
};

describe('first-look result', () => {
  it('reads progress and, once done, "who you are" plus the company → project → team structure', async () => {
    const { scanned, view } = setup([], DONE);
    await scanned();
    const screen = await view();
    const data = (await screen?.read(new URLSearchParams())) as unknown as FirstLookProgress & { result: FirstLookResult };
    expect(data.status).toBe('done');
    expect(data.percent).toBe(100);
    expect(data.phases[0]?.total).toBe(400);
    expect(data.result.about).toBe('개발자 겸 운영자. ACME 커뮤니티를 운영하고 교육 서비스를 만들어요');
    expect(data.result.plan?.status).toBe('proposed');
    expect(data.result.companies).toEqual([
      {
        name: 'ACME',
        relation: 'own',
        projects: [
          { name: 'BetaLab', purpose: '학습 플랫폼', team: { kind: 'dev', roles: [{ title: '개발', does: '기능을 만들어요' }] }, routines: [] },
          { name: 'clipper', purpose: '감사 대응', team: { kind: 'general', roles: [] }, routines: [{ title: '감사 일정 점검', when: '매주 월 09:00', schedule: { kind: 'weekly', day: 'mon', at: '09:00' } }] },
          { name: '커뮤니티', purpose: '', team: { kind: 'general', roles: [] }, routines: [] },
        ],
      },
    ]);
  });

  it('splits, moves and renames from one plain sentence, refiles moved projects, and refuses invented projects', async () => {
    const edits = {
      edits: [
        { op: 'move_project', project: 'P1', to: 'BetaLab' },
        { op: 'move_project', project: 'P2', to: 'BetaLab' },
        { op: 'add_project', name: '비밀 프로젝트', company: 'C1' },
        { op: 'rename_project', project: 'P3', to: 'ACME 커뮤니티' },
        { op: 'add_role', project: 'P2', title: '일정 관리', does: '감사 일정을 챙겨요' },
        { op: 'bogus' },
      ],
    };
    const { scanned, view, corrected, context, llm } = setup([JSON.stringify(edits)], DONE);
    await scanned();
    const screen = await view();
    const out = (await screen?.actions?.['revise']?.({ text: '아니, ACME랑 BetaLab은 따로야. clipper은 BetaLab 아래. 커뮤니티 이름은 ACME 커뮤니티' })) as { text: string; changed: string[]; skipped: string[]; result: FirstLookResult };
    expect(llm.requests[1]?.tier).toBe('standard');
    expect(String(llm.requests[1]?.messages[1]?.content)).toContain('P2. clipper [general]');
    expect(out.text).toBe(
      "이렇게 바꿨어요: BetaLab → BetaLab (따로 나눔), clipper → BetaLab 아래로, 프로젝트 이름 커뮤니티 → ACME 커뮤니티, clipper에 역할 '일정 관리' 추가. 이건 그대로 뒀어요: 비밀 프로젝트 (말씀하신 적 없는 프로젝트라 만들지 않았어요).",
    );
    expect(names(out.result)).toEqual(['BetaLab: BetaLab, clipper', 'ACME: ACME 커뮤니티']);
    // the split company keeps the relation it came from
    expect(out.result.companies[0]?.relation).toBe('own');
    expect((await readPlan(context.kv))?.teams.find((team) => team.name === 'clipper')?.roles).toEqual([{ title: '일정 관리', does: '감사 일정을 챙겨요' }]);
    expect(corrected).toEqual([
      { id: lineId('project', 'BetaLab', 'company'), text: 'BetaLab' },
      { id: lineId('project', 'clipper', 'company'), text: 'BetaLab' },
    ]);
  });

  it('merges companies, follows a renamed project back to its knowledge topic, and answers from chat with the tree', async () => {
    const first = { edits: [{ op: 'rename_project', project: 'P2', to: '감사' }] };
    const second = { edits: [{ op: 'move_project', project: 'P2', to: '외주' }] };
    const { scanned, flow, corrected, context } = setup([JSON.stringify(first), JSON.stringify(second)], DONE);
    await scanned();
    await flow.revise('clipper 이름은 감사로');
    const tool = context.registry.get('bots.revise_plan');
    const outcome = (await tool?.run({ instruction: '감사는 외주 아래로' }, { log: context.ctx.log, signal: new AbortController().signal, call: { grounding: [] } })) as { text: string; tree: string };
    expect(outcome.text).toBe('이렇게 바꿨어요: 감사 → 외주 (따로 나눔).');
    expect(outcome.tree).toContain('■ 외주\n  · 감사');
    expect(corrected).toEqual([{ id: lineId('project', 'clipper', 'company'), text: '외주' }]);
  });

  it('applies merges in code and leaves an unknown company alone', () => {
    const teams = [
      { company: 'A', name: 'x', purpose: '', kind: 'general' as const, roles: [], tasks: [], routines: [] },
      { company: 'B', name: 'y', purpose: '', kind: 'general' as const, roles: [], tasks: [], routines: [] },
    ];
    const out = applyEdits({ teams, relations: { A: 'client' }, instruction: 'A랑 B는 같은 회사야, 이름은 AB', korean: true }, [
      { op: 'merge_companies', companies: ['C1', 'C2'], into: 'AB' },
      { op: 'rename_company', company: 'Z', to: 'Q' },
      { op: 'set_relation', company: 'C1', relation: 'own' },
    ]);
    expect(out.teams.map((team) => team.company)).toEqual(['AB', 'AB']);
    expect(out.changed).toEqual(['A·B 합쳐서 AB', 'AB: 내 사업']);
    expect(out.skipped).toEqual(['Z (계획에 없는 회사예요)']);
    expect([...out.moved.keys()]).toEqual(['x', 'y']);
  });

  it('says so when there is nothing to revise or the model fails', async () => {
    const { flow, scanned } = setup(['not json at all']);
    await expect(flow.revise('아무거나')).rejects.toThrow('고칠 팀 구조 제안이 없어요');
    await scanned();
    expect((await flow.revise('ACME랑 BetaLab은 따로야')).text).toBe('지금은 고치지 못했어요. 잠시 뒤 다시 말씀해 주세요.');
  });
});
