import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { FirstLookProgress } from '../../core/contracts/first-look.js';
import type { KnowledgeLine } from '../../core/contracts/knowledge.js';
import { ViewInputError, ownerInputError } from '../../core/contracts/device-api.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { lineId } from '../../core/text/line-id.js';
import type { TeamPlan } from './team-plan.js';
import { PlanSchema, planText, readPlan, savePlan, scheduleText } from './team-plan.js';
import type { TeamPlanFlow } from './team-plan-flow.js';
import type { Relation } from './team-plan-edits.js';
import { RELATIONS, RELATION_KO, applyEdits } from './team-plan-edits.js';
import { editsFromWords } from './team-plan-revise.js';

const MEMO_KEY = 'first-look';
const MAX_WORDS = 500;

/** What the scan said about the owner that the plan itself does not keep, plus which knowledge topic each project came from. */
const MemoSchema = z.object({
  about: z.string().default(''),
  relations: z.record(z.string(), z.enum(RELATIONS)).default({}),
  /** Current project name → the knowledge topic its lines are filed under (differs after a rename). */
  topics: z.record(z.string(), z.string()).default({}),
});
type Memo = z.infer<typeof MemoSchema>;

export interface FirstLookResult {
  about: string;
  companies: {
    name: string;
    relation: Relation;
    projects: {
      name: string;
      purpose: string;
      team: { kind: 'dev' | 'general'; roles: { title: string; does: string }[] };
      routines: ResultRoutine[];
      /** A real department or team: its lead, members and the unit above it. */
      unit?: NonNullable<TeamPlan['teams'][number]['unit']>;
    }[];
  }[];
  /** Recurring work the main assistant takes on (it belongs to no team). */
  routines?: ResultRoutine[];
  plan: { id: string; status: TeamPlan['status'] } | null;
}

type PlannedRoutine = TeamPlan['teams'][number]['routines'][number];

interface ResultRoutine {
  title: string;
  when: string;
  schedule: PlannedRoutine['schedule'];
  evidence?: string[];
}

function resultRoutine(routine: PlannedRoutine, korean: boolean): ResultRoutine {
  return { title: routine.title, when: scheduleText(routine.schedule, korean), schedule: routine.schedule, ...(routine.evidence !== undefined ? { evidence: [...routine.evidence] } : {}) };
}

export interface RevisionOutcome {
  text: string;
  changed: string[];
  skipped: string[];
  result: FirstLookResult;
}

const IDLE: FirstLookProgress = { status: 'idle', phase: 'local', phases: [], counts: {}, percent: 0, startedAt: null };

/** "(다니는 곳)" in an org line back to its relation. */
function relationOf(text: string): Relation | undefined {
  const label = /\(([^)]+)\)/.exec(text)?.[1]?.trim();
  return RELATIONS.find((relation) => relation === label || RELATION_KO[relation] === label);
}

export function memoFromScan(profile: readonly KnowledgeLine[]): Memo {
  const occupation = profile.find((line) => line.topic === 'role' && line.key === 'occupation')?.text ?? '';
  const relations: Record<string, Relation> = {};
  for (const line of profile) {
    if (line.topic !== 'org') continue;
    const relation = relationOf(line.text);
    if (relation !== undefined) relations[line.key] = relation;
  }
  // "디자이너 — 브랜드 일을 하는 1인 스튜디오 대표" reads as one sentence.
  return { about: occupation.replace(/\s+—\s+/, '. ').trim(), relations, topics: {} };
}

/**
 * The first-look result screen (view `first-look`, docs/APP-PROTOCOL.md §27): live progress from the onboarding skill,
 * then "this is you, and this is the structure you seem to need", corrected in plain words until the owner builds it.
 */
export class FirstLookFlow {
  constructor(private readonly deps: { ctx: PluginContext; korean: boolean; plans: TeamPlanFlow }) {}

  private async memo(): Promise<Memo> {
    const parsed = MemoSchema.safeParse(await this.deps.ctx.kv.get<unknown>(MEMO_KEY));
    return parsed.success ? parsed.data : { about: '', relations: {}, topics: {} };
  }

  async plan(): Promise<TeamPlan | undefined> {
    return await readPlan(this.deps.ctx.kv);
  }

  async result(): Promise<FirstLookResult> {
    const { ctx } = this.deps;
    const [plan, memo] = [await readPlan(ctx.kv), await this.memo()];
    let about = memo.about;
    if (about === '') about = (await ctx.tryUse(Contracts.knowledgeProfile)?.summary(300).catch(() => undefined)) ?? '';
    const teams = plan?.teams ?? [];
    const companies = [...new Set(teams.map((team) => team.company))].map((name) => ({
      name,
      // personal work is personal (not a job); anything else starts as the workplace and the owner corrects it
      relation: memo.relations[name] ?? (/^(개인|personal)$/i.test(name) ? 'personal' : 'employer'),
      projects: teams
        .filter((team) => team.company === name)
        .map((team) => ({
          name: team.name,
          purpose: team.purpose,
          team: { kind: team.kind, roles: team.roles.map((role) => ({ ...role })) },
          routines: team.routines.map((routine) => resultRoutine(routine, this.deps.korean)),
          ...(team.unit !== undefined ? { unit: { ...team.unit, members: [...team.unit.members] } } : {}),
        })),
    }));
    const routines = (plan?.routines ?? []).map((routine) => resultRoutine(routine, this.deps.korean));
    return { about, companies, routines, plan: plan === undefined ? null : { id: plan.id, status: plan.status } };
  }

  async read(): Promise<Record<string, unknown>> {
    const progress = this.deps.ctx.tryUse(Contracts.firstLook)?.progress() ?? IDLE;
    const plan = await readPlan(this.deps.ctx.kv);
    const show = progress.status === 'done' || (plan?.status === 'proposed' && progress.status !== 'running');
    return { ...progress, ...(show ? { result: await this.result() } : {}) };
  }

  /** The owner's sentence → edits → the proposed plan, and the moved projects' knowledge documents, follow. */
  async revise(instruction: string): Promise<RevisionOutcome> {
    const { ctx, korean } = this.deps;
    const plan = await readPlan(ctx.kv);
    if (plan === undefined || plan.status === 'declined') {
      throw ownerInputError(korean ? '고칠 팀 구조 제안이 없어요. 처음 알아보기가 끝나면 다시 말씀해 주세요.' : 'There is no proposed structure to change yet.');
    }
    const memo = await this.memo();
    const words = instruction.trim().slice(0, MAX_WORDS);
    const edits = await editsFromWords({ llm: ctx.llm, log: ctx.log, korean }, { teams: plan.teams, relations: memo.relations, instruction: words });
    if (edits === undefined) {
      const text = korean ? '지금은 고치지 못했어요. 잠시 뒤 다시 말씀해 주세요.' : 'I could not change it just now. Please try again in a moment.';
      return { text, changed: [], skipped: [], result: await this.result() };
    }
    const outcome = applyEdits({ teams: plan.teams, relations: memo.relations, instruction: words, korean }, edits);
    const valid = PlanSchema.shape.teams.safeParse(outcome.teams);
    if (!valid.success) {
      return { text: korean ? '그렇게 바꾸면 팀 구조가 맞지 않아요. 조금 다르게 말씀해 주세요.' : 'That change does not fit the plan. Please say it differently.', changed: [], skipped: outcome.skipped, result: await this.result() };
    }
    const known = new Map(Object.entries(memo.topics));
    for (const [before, after] of outcome.renamed) {
      const topic = known.get(before) ?? before;
      known.delete(before);
      known.set(after, topic);
    }
    const topics = Object.fromEntries(known);
    // teams already built: the correction moves and renames them too (built teams are never deleted by words)
    const synced = plan.status === 'applied' && outcome.changed.length > 0 ? await this.deps.plans.syncApplied(plan.teams, valid.data, outcome.renamed) : undefined;
    if (synced !== undefined) outcome.skipped.push(...synced.notApplied);
    if (outcome.changed.length > 0) {
      await savePlan(ctx.kv, { ...plan, teams: valid.data });
      await ctx.kv.set(MEMO_KEY, { ...memo, relations: outcome.relations, topics });
      await this.refile(outcome.moved, topics);
    }
    const parts: string[] = [];
    if (outcome.changed.length > 0) parts.push(korean ? `이렇게 바꿨어요: ${outcome.changed.join(', ')}.` : `Changed: ${outcome.changed.join(', ')}.`);
    else parts.push(korean ? '바꿀 곳을 찾지 못했어요. 예: "에이컴퍼니랑 베타랩은 따로야", "쇼핑몰 앱은 베타랩 아래".' : 'I found nothing to change. E.g. "A and B are separate", "C goes under B".');
    if (outcome.skipped.length > 0) parts.push(korean ? `이건 그대로 뒀어요: ${outcome.skipped.join(', ')}.` : `Left as is: ${outcome.skipped.join(', ')}.`);
    return { text: parts.join(' '), changed: outcome.changed, skipped: outcome.skipped, result: await this.result() };
  }

  /**
   * A moved project's "company" knowledge line gets the owner's correction, so its document moves to the new company's
   * folder now and later scans keep it there (a correction outranks a scan line).
   */
  private async refile(moved: ReadonlyMap<string, string>, topics: Readonly<Record<string, string>>): Promise<void> {
    const writer = this.deps.ctx.tryUse(Contracts.knowledgeWrite);
    if (writer === undefined) return;
    for (const [project, company] of moved) {
      const topic = topics[project] ?? project;
      await writer.correct(lineId('project', topic, 'company'), company).catch((error: unknown) => {
        this.deps.ctx.log.warn('assistant: a moved project could not be refiled', { error: error instanceof Error ? error.name : 'unknown' });
      });
    }
  }

  /** Starts the first look when it never ran, or ran before Google was connected (no Drive files read then). */
  async autoStart(): Promise<void> {
    const { ctx, korean } = this.deps;
    const reader = ctx.tryUse(Contracts.firstLook);
    if (reader === undefined) return;
    const progress = reader.progress();
    if (progress.status === 'running' || progress.status === 'paused') return;
    const google = ctx.tryUse(Contracts.filesDrive) !== undefined || ctx.tryUse(Contracts.mailRead) !== undefined;
    const never = progress.status === 'idle' && progress.startedAt === null;
    const withoutGoogle = progress.status === 'done' && google && (progress.counts.drive ?? 0) === 0 && (await ctx.kv.get<boolean>(AUTO_GOOGLE_KEY)) !== true;
    if (!never && !withoutGoogle) return;
    if (withoutGoogle) await ctx.kv.set(AUTO_GOOGLE_KEY, true);
    if (reader.start() !== 'started') return;
    const text = korean
      ? withoutGoogle ? '구글이 연결돼서 드라이브와 메일까지 다시 알아보기 시작했어요. 끝나면 사람·팀·루틴을 정리해서 보여 드릴게요.' : '처음 알아보기를 시작했어요. 문서와 메일을 읽고 사람·팀·루틴을 정리해서 보여 드릴게요.'
      : withoutGoogle ? 'Google is connected, so I started reading Drive and mail too.' : 'I started the first look.';
    await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'onboarding.progress', text, dedupeKey: `first-look-auto:${withoutGoogle ? 'google' : 'first'}` }).catch(() => undefined);
  }

  /** `tool`: offer `bots.revise_plan` in chat (only where bots can be built at all). */
  register(opts: { tool: boolean }): void {
    const { ctx, korean } = this.deps;
    ctx.bus.on('knowledge.scanned', async (scan) => {
      await ctx.kv.set(MEMO_KEY, memoFromScan(scan.profile));
    });
    if (opts.tool) ctx.registerTool(reviseTool(this, korean));
    // the first look starts on its own: once after setup, and again once when Google (Drive, mail) gets connected later
    ctx.scheduler.add({ name: 'assistant.first-look-auto', label: korean ? '처음 알아보기 자동 시작' : 'First look auto start', schedule: { kind: 'every', seconds: 1800 }, run: () => this.autoStart() });
    ctx.bus.on('app.started', () => {
      const views = ctx.tryUse(Contracts.appViews);
      if (views === undefined) return;
      views.register({
        name: 'first-look',
        version: 1,
        read: async () => await this.read(),
        actions: {
          revise: async (body) => {
            const parsed = z.object({ text: z.string().trim().min(1).max(MAX_WORDS) }).safeParse(body);
            if (!parsed.success) throw new ViewInputError('shape');
            return { ...(await this.revise(parsed.data.text)) };
          },
          apply: async () => ({ ...(await this.deps.plans.apply()) }),
          start: async () => {
            const reader = ctx.tryUse(Contracts.firstLook);
            if (reader === undefined) throw ownerInputError(korean ? '처음 알아보기가 꺼져 있어요.' : 'The first look is turned off.');
            return { scan: reader.start() };
          },
        },
      });
      views.addFeature?.('first-look');
    });
  }
}

const AUTO_GOOGLE_KEY = 'first-look.auto-google';

const reviseInput = z.object({ instruction: z.string().min(1).max(MAX_WORDS).describe("The owner's correction in their own words, e.g. \"에이컴퍼니랑 베타랩은 따로야. 쇼핑몰 앱은 베타랩 아래\".") });

/** `bots.revise_plan`: the same correction from chat; the reply carries the new tree. */
function reviseTool(flow: FirstLookFlow, korean: boolean): Tool<z.infer<typeof reviseInput>, { text: string; tree: string }> {
  return {
    name: 'bots.revise_plan',
    description:
      'Change the PROPOSED company → project → team structure (from the first look) the way the owner says: split or merge companies, move or rename projects, drop a project, add or remove roles and routines. Use when the owner corrects that structure in words; show the returned tree.',
    input: reviseInput,
    effects: ['write'],
    describe: (value) => (korean ? `팀 구조 제안 고치기: ${value.instruction}` : `Change the proposed team structure: ${value.instruction}`),
    async run(value) {
      const outcome = await flow.revise(value.instruction);
      const plan = await flow.plan();
      return { text: outcome.text, tree: plan === undefined ? '' : planText(plan, korean) };
    },
  };
}
