import { z } from 'zod';
import type { Composer } from '../../core/bots/composition.js';
import { applyPlan, planFromScan } from '../../core/bots/from-scan.js';
import type { BotDirectory, BotTeam } from '../../core/contracts/bots.js';
import { teamName } from '../../core/contracts/bots.js';
import type { SyncResult } from './team-plan-sync.js';
import { syncBuiltTeams } from './team-plan-sync.js';
import { Contracts } from '../../core/contracts/index.js';
import type { ScanResult } from '../../core/contracts/knowledge.js';
import { mergeTeams, placeRoutines, projectTeams, sameAsBefore, unitTeams } from './team-plan-units.js';
import { ViewInputError } from '../../core/contracts/device-api.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { PlanTeam, TeamPlan } from './team-plan.js';
import { PlanSchema, planText, readPlan, savePlan, suggestRoutines } from './team-plan.js';

export interface TeamPlanDeps {
  ctx: PluginContext;
  korean: boolean;
  directory: () => BotDirectory | undefined;
  compose?: Composer;
  /** Writes role prompts for a new team in the background. */
  refine: (team: BotTeam) => void;
}

const saveInput = z.object({ teams: PlanSchema.shape.teams });

/**
 * The first look proposes the company → team → role structure (and routines for the recurring work) instead of building
 * it: the owner sees it on one card or edits it in the app, and only "이대로 만들기" builds teams and routines.
 */
export class TeamPlanFlow {
  constructor(private readonly deps: TeamPlanDeps) {}

  /**
   * True when the scan had something to propose: the real departments and teams it found, the picked projects, and
   * the recurring work with its evidence. False leaves the older automatic teams in charge. A plan still waiting is
   * updated in place (no second card); an answered one is proposed again only when something new turned up.
   */
  async propose(scan: Pick<ScanResult, 'projects' | 'units' | 'routines'>): Promise<boolean> {
    const planned = planFromScan(scan.projects);
    const teams = mergeTeams(unitTeams(scan.units ?? []), projectTeams(planned));
    if (teams.length === 0 && (scan.routines ?? []).length === 0) return false;
    const { ctx, korean } = this.deps;
    const own = placeRoutines(teams, scan.routines ?? []);
    // the work map's recurring tasks still get routines where nothing better was found
    const suggested = await suggestRoutines({ llm: ctx.llm, log: ctx.log, korean }, planned.filter((team) => !teams.some((item) => item.name === team.name && item.routines.length > 0)));
    for (const team of teams) if (team.routines.length === 0) team.routines.push(...(suggested.get(team.name) ?? []));
    const previous = await readPlan(ctx.kv);
    if (previous !== undefined && previous.status !== 'proposed' && sameAsBefore(previous, teams, own)) return true;
    const at = ctx.clock.now().toISOString();
    if (previous?.status === 'proposed') {
      await savePlan(ctx.kv, { ...previous, teams, routines: own });
      return true;
    }
    const plan: TeamPlan = { id: `p${ctx.clock.now().getTime().toString(36)}`, createdAt: at, status: 'proposed', teams, routines: own };
    await savePlan(ctx.kv, plan);
    void this.ask(plan);
    return true;
  }

  private async ask(plan: TeamPlan): Promise<void> {
    const { ctx, korean } = this.deps;
    const questions = ctx.tryUse(Contracts.questions);
    if (questions === undefined) return;
    const answer = await questions
      .ask({
        topic: `bots:team-plan:${plan.id}`,
        summary: korean ? '일 지도대로 이렇게 팀을 만들까요?' : 'Shall I set up these teams from your work map?',
        note: `${planText(plan, korean)}\n${korean ? '만든 뒤에도 봇 화면에서 팀 이름·사람·역할을 바로 바꿀 수 있어요.' : 'After building, rename teams and move people right on the bots screen.'}`,
        choices: [
          { id: 'build', label: korean ? '이대로 만들기' : 'Build it', tone: 'primary', means: 'approved' },
          { id: 'later', label: korean ? '나중에' : 'Later', means: 'later' },
          { id: 'no', label: korean ? '만들지 않기' : 'Don’t', means: 'denied' },
        ],
        effects: ['write'],
        askedBy: 'skill.assistant',
        laterMs: 7 * 24 * 60 * 60 * 1000,
      })
      .catch(() => undefined);
    if (answer?.status !== 'answered' || answer.reused) return;
    const current = await readPlan(ctx.kv);
    if (current?.id !== plan.id || current.status !== 'proposed') return;
    if (answer.means === 'approved') await this.apply();
    else if (answer.means === 'denied') await savePlan(ctx.kv, { ...current, status: 'declined' });
  }

  /** A correction after the teams were built: moves, renames and new projects land on the built teams. */
  async syncApplied(before: readonly PlanTeam[], after: readonly PlanTeam[], renamed: ReadonlyMap<string, string>): Promise<SyncResult | undefined> {
    const directory = this.deps.directory();
    if (directory === undefined) return undefined;
    const { ctx, korean } = this.deps;
    const control = ctx.tryUse(Contracts.llmControl);
    const result = await syncBuiltTeams(directory, before, after, renamed, {
      korean,
      now: ctx.clock.now(),
      ...(control !== undefined ? { control } : {}),
      ...(this.deps.compose !== undefined ? { compose: this.deps.compose } : {}),
    });
    for (const team of await directory.teams()) this.deps.refine(team);
    return result;
  }

  /** Builds the plan's groups and teams, then gives each team lead its routines. */
  async apply(): Promise<{ teams: number; routines: number }> {
    const { ctx, korean } = this.deps;
    const plan = await readPlan(ctx.kv);
    const directory = this.deps.directory();
    if (plan === undefined || plan.status === 'applied' || directory === undefined) return { teams: 0, routines: 0 };
    const control = ctx.tryUse(Contracts.llmControl);
    const made = await applyPlan(directory, plan.teams, korean, ctx.clock.now(), control, this.deps.compose);
    const groups = await directory.groups();
    const teams = await directory.teams();
    for (const team of teams) this.deps.refine(team);
    let routines = 0;
    for (const planned of plan.teams) {
      const group = groups.find((item) => item.label === planned.company.slice(0, 40));
      const team = teams.find((item) => item.group === group?.id && item.name === teamName(planned.name));
      if (team === undefined) continue;
      for (const routine of planned.routines) {
        const outcome = await ctx.tools.execute('routines.add', { title: routine.title, instruction: routine.instruction, schedule: routine.schedule, bot: team.lead }, { grounding: [] });
        if (outcome.status === 'done') routines += 1;
      }
    }
    for (const routine of plan.routines) {
      const outcome = await ctx.tools.execute('routines.add', { title: routine.title, instruction: routine.instruction, schedule: routine.schedule }, { grounding: [] });
      if (outcome.status === 'done') routines += 1;
    }
    await savePlan(ctx.kv, { ...plan, status: 'applied', appliedAt: ctx.clock.now().toISOString() });
    const text = korean ? `팀 ${made}개${routines > 0 ? `와 루틴 ${routines}개` : ''}를 만들었어요. 봇 목록에서 볼 수 있어요.` : `Set up ${made} teams${routines > 0 ? ` and ${routines} routines` : ''}.`;
    await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'bots.teams', text }).catch(() => undefined);
    return { teams: made, routines };
  }

  /** View "team-plan": the proposed structure, edits, then build or drop it. */
  registerView(): void {
    const { ctx } = this.deps;
    ctx.bus.on('app.started', () => {
      const views = ctx.tryUse(Contracts.appViews);
      if (views === undefined) return;
      views.register({
        name: 'team-plan',
        version: 1,
        read: async () => {
          const plan = await readPlan(ctx.kv);
          return plan === undefined ? { plan: null } : { plan };
        },
        actions: {
          save: async (body) => {
            const parsed = saveInput.safeParse(body);
            const plan = await readPlan(ctx.kv);
            if (!parsed.success) throw new ViewInputError('shape');
            if (plan === undefined || plan.status !== 'proposed') throw new ViewInputError('no proposed plan');
            await savePlan(ctx.kv, { ...plan, teams: parsed.data.teams });
            return { saved: parsed.data.teams.length };
          },
          apply: async () => ({ ...(await this.apply()) }),
          decline: async () => {
            const plan = await readPlan(ctx.kv);
            if (plan !== undefined && plan.status === 'proposed') await savePlan(ctx.kv, { ...plan, status: 'declined' });
            return { declined: plan?.status === 'proposed' };
          },
        },
      });
      views.addFeature?.('team-plan');
    });
  }
}
