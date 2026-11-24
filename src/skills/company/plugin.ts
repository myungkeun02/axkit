import { buildTeam, refineInstructions } from '../../core/bots/teams.js';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin, PluginContext, PluginInstance } from '../../core/plugin/types.js';
import { backlogCheck, backlogReader } from './backlog.js';
import { readCompanyConfig } from './config.js';
import { decisionHandler } from './decisions.js';
import { intakeHandler, registerEventIntake, registerMailIntake, submitTool } from './intake.js';
import type { IntakeDeps } from './intake.js';
import { routeTeam } from './llm.js';
import { intakeTexts, reportTexts } from './locale-intake.js';
import { workTexts } from './locale-work.js';
import { CompanyOverrides, listenOverrides } from './overrides.js';
import { CompanyPipeline } from './pipeline.js';
import { companyDocsTool, companyProfileTool, onboardingNotice } from './profile.js';
import { reapTasks } from './reaper.js';
import { registerReport } from './report.js';
import { keywordTeam } from './route.js';
import { KvTaskRepository } from './store.js';
import { ensureTeamDocs, syncDirectoryTeamDocs } from './team-docs.js';
import type { CompanyLimits } from './types.js';

function registerProfileTools(ctx: PluginContext): void {
  const texts = workTexts(ctx.assistant.language);
  const deps = { docs: () => ctx.tryUse(Contracts.docs), texts };
  ctx.registerTool(companyProfileTool(deps));
  ctx.registerTool(companyDocsTool(deps));
}

export function companySkill(): Plugin {
  return {
    manifest: {
      id: 'skill.company',
      kind: 'skill',
      title: 'Company mode (team bots with work caps; optional)',
    },
    async setup(ctx): Promise<PluginInstance> {
      const config = readCompanyConfig(ctx);
      // the app's bot list shows the company's teams under one group
      const directory = ctx.tryUse(Contracts.bots);
      if (directory !== undefined && config.teams.length > 0) {
        await directory.upsertGroup({ id: 'company', label: config.prefix }).catch(() => undefined);
        for (const team of config.teams) {
          await directory
            .upsert({ id: team.id, name: team.name, role: team.role, group: 'company', kind: team.kind, origin: 'company' })
            .catch(() => undefined);
          // R16: a company team is a lead (this bot) with staff under it, and a reviewer on dev teams
          const built = await buildTeam(directory, { group: 'company', name: team.name, purpose: team.role, kind: team.kind, leadId: team.id, origin: 'company' }, ctx.assistant.language !== 'en', ctx.clock.now(), ctx.tryUse(Contracts.llmControl)).catch(() => undefined);
          if (built !== undefined) void refineInstructions(ctx.llm, directory, built, ctx.assistant.language !== 'en').catch(() => 0);
        }
      }
      const texts = workTexts(ctx.assistant.language);
      registerProfileTools(ctx);
      if (config.teams.length === 0) {
        ctx.log.info('company: no teams configured, company mode is idle');
        return {};
      }

      const repo = new KvTaskRepository(ctx.kv, () => ctx.clock.now());
      const overrides = new CompanyOverrides(ctx.kv);
      const limits = (): Promise<CompanyLimits> => overrides.limits(config);
      const unsubscribeTuning = listenOverrides(ctx, overrides);

      const intakeDeps: IntakeDeps = {
        ctx,
        repo,
        config,
        limits,
        texts: intakeTexts(ctx.assistant.language),
        classify: async (request) => {
          const id = await routeTeam(ctx.llm, config.teams, request);
          return config.teams.find((team) => team.id === id) ?? keywordTeam(request, config.teams);
        },
      };
      ctx.registerHandler(intakeHandler(intakeDeps));
      ctx.registerTool(submitTool(intakeDeps));
      const unsubscribeEvents = registerEventIntake(intakeDeps);
      registerMailIntake(intakeDeps, () => ctx.tryUse(Contracts.mailRead));
      ctx.registerHandler(decisionHandler({ ctx, repo, texts }));

      const pipeline = new CompanyPipeline({ ctx, repo, config, limits, texts });
      ctx.scheduler.add({
        name: 'company.tick',
        schedule: { kind: 'every', seconds: 60 },
        async run(now) {
          await pipeline.tick(now);
        },
      });

      registerReport(ctx, repo, config, reportTexts(ctx.assistant.language), async () =>
        reapTasks(repo, await limits(), ctx.clock.now()),
      );

      // teams made in chat (the bot directory) get a doc too, kept in step with who is in them
      const WRITTEN = 'team-docs-written';
      const syncTeams = async (): Promise<void> => {
        const docs = ctx.tryUse(Contracts.docs);
        const directory = ctx.tryUse(Contracts.bots);
        if (docs === undefined || directory === undefined) return;
        const [teams, bots] = [await directory.teams(), await directory.list()];
        const members = (id: string) => bots.filter((bot) => bot.team === id).map((bot) => ({ name: bot.name, role: bot.role }));
        const written = new Map(Object.entries((await ctx.kv.get<Record<string, string>>(WRITTEN)) ?? {}));
        await syncDirectoryTeamDocs(docs, teams.map((team) => ({ id: team.id, name: team.name, ...(team.purpose !== undefined ? { purpose: team.purpose } : {}), members: members(team.id) })), texts, written);
        await ctx.kv.set(WRITTEN, Object.fromEntries(written));
      };
      ctx.scheduler.add({ name: 'company.team-docs', schedule: { kind: 'every', seconds: 600 }, run: () => syncTeams().catch(() => undefined) });

      const reader = backlogReader(repo, limits);
      ctx.provide(Contracts.backlog, reader);
      ctx.tryUse(Contracts.health)?.register(backlogCheck(reader, reportTexts(ctx.assistant.language)));

      return {
        async start() {
          const docs = ctx.tryUse(Contracts.docs);
          if (docs === undefined) return;
          await ensureTeamDocs(docs, config.teams, texts);
          await syncTeams().catch(() => undefined);
          await onboardingNotice(ctx, docs, texts);
        },
        async stop() {
          unsubscribeTuning();
          unsubscribeEvents();
        },
      };
    },
  };
}
