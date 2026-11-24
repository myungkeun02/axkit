import type { Toolbox } from '../../core/tools/types.js';
import { Contracts } from '../../core/contracts/index.js';
import type { MessageHandler } from '../../core/conversation/types.js';
import type { Plugin } from '../../core/plugin/types.js';
import { profileSummary, recalledFacts } from './recall.js';
import { assistantTexts } from './locale.js';
import { runTurn } from './loop.js';
import type { TurnResult } from './loop.js';
import { MemoryStore } from './memory.js';
import { buildSystemPrompt, loadSystemTemplate } from './prompt.js';
import type { Bot, BotDirectory, BotTeam } from '../../core/contracts/bots.js';
import { refineInstructions } from '../../core/bots/teams.js';
import { botAddress, botOfAddress, meetingChannel } from '../../core/contracts/bots.js';
import { Meetings } from './meeting.js';
import { TeamHealth, resizeFor } from '../../core/bots/team-health.js';
import { proposeResize } from './resize.js';
import { teamsFromScan } from '../../core/bots/from-scan.js';
import { composer } from '../../core/bots/composition.js';
import { runTeam } from './team-run.js';
import type { BotReply, Who } from './team-run.js';
import type { IncomingMessage, TurnContext } from '../../core/conversation/types.js';
import { OWNER_THREAD_REF } from '../../core/conversation/thread.js';
import { assistantRunner } from './runner.js';
import type { RunnerTurn } from './runner.js';
import { botReply, childContext, outgoingOf } from './child-turn.js';
import { Continuity } from './continuity.js';
import { TeamPlanFlow } from './team-plan-flow.js';
import { FirstLookFlow } from './first-look.js';
import { cleanStoredInstructions } from '../../core/bots/instructions.js';
import { companySection } from './company-context.js';
import { ownChat, withinBudget } from './prompt-budget.js';
import { Initiative, initiativeTool } from './initiative.js';
import { createBotTool, delegateTool, forScheduledRun, mentionSection, personaSection, rosterSection, withoutDelegation } from './bots.js';

export interface AssistantSkillOptions {
  /** Tests inject a fixture; production reads prompts/assistant/system.md. */
  loadSystemPrompt?: () => Promise<string>;
}

const MAX_STEPS_DEFAULT = 4;
const HISTORY_TURNS_DEFAULT = 12;

function intOption(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/** The fallback conversation handler: plans with the model, runs tools through the policy, replies. */
export function assistantSkill(opts: AssistantSkillOptions = {}): Plugin {
  return {
    manifest: {
      id: 'skill.assistant',
      kind: 'skill',
      title: 'Assistant',
    },
    setup(ctx) {
      const texts = assistantTexts(ctx.assistant.language);
      const maxSteps = intOption(ctx.config['maxSteps'], MAX_STEPS_DEFAULT, 10);
      const historyTurns = intOption(ctx.config['historyTurns'], HISTORY_TURNS_DEFAULT, 100);
      const memory = new MemoryStore({
        kv: ctx.kv,
        llm: ctx.llm,
        clock: ctx.clock,
        log: ctx.log,
        historyTurns,
      });

      const load = opts.loadSystemPrompt ?? loadSystemTemplate;
      let template: Promise<string> | undefined;
      const systemTemplate = (): Promise<string> => {
        template ??= load().catch((error: unknown) => {
          template = undefined;
          throw error;
        });
        return template;
      };

      const korean = ctx.assistant.language !== 'en';
      const continuity = new Continuity(ctx, korean);
      continuity.schedule();
      const bots = (): BotDirectory | undefined => ctx.tryUse(Contracts.bots);
      // other skills add a short, message-dependent section (known sites, how to find a way…)
      const sections = new Map<string, (text: string) => Promise<string | undefined>>();
      ctx.provide(Contracts.assistantContext, { addSection: (id, section) => void sections.set(id, section) });
      const extraSections = async (text: string): Promise<string[]> => {
        const out: string[] = [];
        for (const section of sections.values()) {
          const value = await section(text).catch(() => undefined);
          if (value !== undefined && value.trim() !== '') out.push(value.trim().slice(0, 2500));
        }
        return out;
      };

      /** A chat the owner types in (an app, Discord…), not a routine run or an internal hand-over. */

/** One turn, in the main chat (with the bot list) or in a bot's room (as that bot, never delegating again). */
      // a bot works without handing on or scheduling; a routine run without scheduling more of itself
      const toolboxFor = (bot: Bot | undefined, message: IncomingMessage): Toolbox =>
        bot !== undefined ? withoutDelegation(ctx.tools) : message.conversation.channelId === 'core.routines' ? forScheduledRun(ctx.tools) : ctx.tools;
      const turn = async (message: IncomingMessage, bot: Bot | undefined, context: TurnContext = {}): Promise<TurnResult> => {
        const facts = await recalledFacts(ctx, message.text);
        const profile = await profileSummary(ctx);
        const base = buildSystemPrompt(await systemTemplate(), {
          assistant: ctx.assistant,
          tools: toolboxFor(bot, message).list(),
          now: ctx.clock.now(),
          facts,
          ...(profile !== undefined ? { profile } : {}),
        });
        const roster = bot === undefined ? ((await bots()?.list().catch(() => [])) ?? []) : [];
        const role = bot !== undefined ? personaSection(bot, korean) : [rosterSection(roster, korean), mentionSection(message.text, roster, korean)].filter((part) => part !== undefined).join('\n\n') || undefined;
        // the owner's own chats share one memory; a bot's room works only from its task
        const own = bot === undefined ? await continuity.sections(message) : [];
        // company docs and the people the owner described hold in every room
        const shared = [await companySection(ctx, korean, bot?.team).catch(() => undefined), await continuity.peopleSection().catch(() => undefined)];
        // most important first; the whole stays within a budget however many bots, docs and skills there are
        const extra = withinBudget([role, ...own, ...shared, ...(await extraSections(message.text))]) || undefined;
        const result = await runTurn(message, {
          llm: ctx.llm,
          tools: toolboxFor(bot, message),
          memory,
          log: ctx.log,
          texts,
          systemPrompt: extra === undefined ? base : `${base}\n\n${extra}`,
          maxSteps,
          ...(bot !== undefined ? { purpose: `bot.${bot.id}` } : {}),
          onTool: (conversation, tool) => {
            void ctx.bus.emit('assistant.activity', { conversation, state: 'working', tool }).catch(() => undefined);
          },
          // only the owner's own chats keep notes: a routine run or a hand-over read mail and pages, not the owner's words
          ...(bot === undefined && ownChat(message) ? { onNotes: (from: IncomingMessage, notes: Parameters<Continuity['notes']>[1]) => continuity.notes(from, notes) } : {}),
          ...(context.onToolDone !== undefined ? { onToolDone: context.onToolDone } : {}),
          ...(context.resumed !== undefined ? { resumed: context.resumed } : {}),
          ...(context.inProgress !== undefined ? { inProgress: context.inProgress } : {}),
          ...(context.awaiting !== undefined ? { awaiting: context.awaiting } : {}),
          ...(context.awaitOwner !== undefined ? { awaitOwner: context.awaitOwner } : {}),
          ...(context.afterTurn !== undefined ? { afterTurn: context.afterTurn } : {}),
        });
        if (bot === undefined && ownChat(message)) await continuity.record(message, result.reply.text);
        return result;
      };

      /**
       * Old turns are folded into the summary after the turn: once its reply is delivered or stored for a retry, and
       * without holding the conversation, so a restart meanwhile never replays a seen answer and the next message
       * never waits on a summary. Without a router turn (bot rooms, routines) it simply runs in the background.
       */
      const compact = (message: IncomingMessage, context: TurnContext = {}): void => {
        const work = async (): Promise<void> => {
          await memory.compact(message.conversation).catch((error: unknown) => ctx.log.warn('assistant: memory compaction failed', { error: error instanceof Error ? error.message : String(error) }));
        };
        if (context.afterTurn !== undefined) context.afterTurn(work);
        else void work();
      };
      // a proactive notice the owner got is part of the owner thread, so "그거 해줘" right after it has context
      ctx.bus.on('notice.delivered', async ({ text }) => {
        await memory.notice(OWNER_THREAD_REF, text).catch(() => undefined);
      });

      const say = async (channel: string, from: Who, to: Who | undefined, text: string): Promise<void> => {
        await ctx.bus.emit('bots.message', { bot: { id: from.id, name: from.name }, text, channel, ...(to !== undefined ? { to: { id: to.id, name: to.name } } : {}) });
      };
      /**
       * One turn as a bot, in its own room; the bot shows as working meanwhile. It runs as part of the owner's turn
       * (`parent`), whose pending entry keeps its finished tools under the bot's id.
       */
      const runAs = async (bot: Bot, text: string, parent: TurnContext = {}): Promise<BotReply> => {
        const directory = bots();
        await directory?.setStatus(bot.id, 'working', text.slice(0, 80)).catch(() => undefined);
        try {
          const message: IncomingMessage = {
            id: `team:${ctx.clock.now().getTime()}:${bot.id}`,
            conversation: { channelId: 'core.delegation', address: botAddress(bot.id) },
            authorId: 'assistant',
            // the task traces back to the owner's own request, split by the lead
            fromOwner: true,
            text,
            receivedAt: ctx.clock.now(),
          };
          const { reply, status } = await turn(message, bot, childContext(parent, bot.id));
          compact(message);
          return botReply(reply, status);
        } finally {
          await directory?.setStatus(bot.id, 'idle').catch(() => undefined);
        }
      };
      const meetings = new Meetings({ ctx, korean, say });
      // R16: teams nobody sized (scan, chat) are sized by the rule-checked composition harness
      const compose = composer(ctx.llm, async () => (await ctx.tryUse(Contracts.llmControl)?.overBudget()) ?? false, korean);
      // every new team member gets a role prompt for this team's job, written in the background (owner edits win)
      const refine = (team: BotTeam): void => {
        const directory = bots();
        if (directory !== undefined) void refineInstructions(ctx.llm, directory, team, korean).catch(() => 0);
      };
      const health = new TeamHealth(ctx.kv);
      const busy = new Set<string>();
      /** A team lead hands the work to its team (R16); any other bot works alone. */
      const work = async (message: IncomingMessage, bot: Bot, context: TurnContext = {}): Promise<BotReply> => {
        const directory = bots();
        const team = bot.rank === 'lead' && directory !== undefined ? (await directory.teams()).find((item) => item.lead === bot.id) : undefined;
        if (team === undefined || directory === undefined) {
          const { reply, status } = await turn(message, bot, context);
          return botReply(reply, status);
        }
        const overlapped = busy.has(team.id);
        busy.add(team.id);
        const record = async (outcome: { tasks: number; failed: number; wantedMore: boolean }): Promise<void> => {
          const runs = await health.record(team.id, { at: ctx.clock.now().toISOString(), ...outcome, overlapped });
          const proposal = resizeFor(team, runs, ctx.clock.now(), korean);
          if (proposal !== undefined) void proposeResize(ctx, directory, team, proposal, korean);
        };
        try {
          return await runTeam({ ctx, korean, runAs: (member, text) => runAs(member, text, context), say, record }, team, await directory.list(), message.text);
        } finally {
          busy.delete(team.id);
        }
      };
      const plans = new TeamPlanFlow({ ctx, korean, directory: bots, compose, refine });
      plans.registerView();
      new FirstLookFlow({ ctx, korean, plans }).register({ tool: bots() !== undefined });
      ctx.bus.on('knowledge.scanned', async (scan) => {
        const directory = bots();
        if (directory === undefined) return;
        // a company → project hierarchy is proposed first (card + app), not built behind the owner's back
        if (await plans.propose(scan).catch(() => false)) return;
        const made = await teamsFromScan(directory, scan, korean, ctx.clock.now(), ctx.tryUse(Contracts.llmControl), compose).catch(() => 0);
        for (const team of await directory.teams()) refine(team);
        if (made > 0) await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'bots.teams', text: korean ? `문서를 보고 팀 ${made}개를 만들었어요. 봇 목록에서 볼 수 있어요.` : `Made ${made} teams from your documents.` }).catch(() => undefined);
      });
      // role prompts saved earlier with the model's preface in them ("역할 프롬프트를 아래에 작성했어요…") are cleaned once
      ctx.bus.on('app.started', () => {
        const directory = bots();
        if (directory !== undefined) void cleanStoredInstructions(directory).catch(() => undefined);
      });
      ctx.bus.on('bots.meeting_requested', async ({ group, topic }) => {
        const directory = bots();
        const found = (await directory?.groups())?.find((item) => item.id === group);
        // one meeting per group at a time: a second request while it runs would double the cost and lose the owner's words
        if (directory === undefined || found === undefined || meetings.isRunning(found.id)) return;
        void meetings.hold(found, await directory.teams(), await directory.list(), topic).catch((error: unknown) => {
          ctx.log.warn('assistant: meeting failed', { error: error instanceof Error ? error.message : 'error' });
        });
      });

      const handler: MessageHandler = {
        id: 'assistant',
        priority: 0,
        async handle(message, replier, context = {}) {
          if (!message.fromOwner) return 'pass';
          const botId = botOfAddress(message.conversation.address);
          const directory = bots();
          // a team room talks to its lead; a meeting room joins or opens the company's lead meeting
          if (botId !== undefined && directory !== undefined && botId.startsWith('team-')) {
            const team = (await directory.teams()).find((item) => item.id === botId);
            const lead = team === undefined ? undefined : await directory.get(team.lead);
            if (lead !== undefined) {
              await replier.reply(message.conversation, outgoingOf(await work(message, lead, context)));
              return 'handled';
            }
          }
          if (botId !== undefined && directory !== undefined && botId.startsWith('meet-')) {
            const group = (await directory.groups()).find((item) => meetingChannel(item.id) === botId);
            if (group !== undefined) {
              // a running meeting hears it at once; a new one starts in the background, so the room stays open
              const text = meetings.ownerSaid(group, await directory.teams(), await directory.list(), message.text);
              await replier.reply(message.conversation, { text });
              return 'handled';
            }
          }
          const bot = botId === undefined ? undefined : await directory?.get(botId);
          if (botId !== undefined && bot === undefined) {
            await replier.reply(message.conversation, { text: korean ? '이 봇은 이제 없어요. 메인 대화에서 말씀해 주세요.' : 'This bot no longer exists. Please use the main chat.' });
            return 'handled';
          }
          const outgoing = bot !== undefined && bot.rank === 'lead' ? outgoingOf(await work(message, bot, context)) : (await turn(message, bot, context)).reply;
          await replier.reply(message.conversation, outgoing);
          compact(message, context);
          return 'handled';
        },
      };
      const runnerTurn = async (message: IncomingMessage): Promise<RunnerTurn> => {
        const { reply, status } = await turn(message, undefined);
        compact(message);
        return { text: reply.text, status };
      };
      const runnerWork = async (message: IncomingMessage, bot: Bot): Promise<RunnerTurn> => {
        const { text, status } = await work(message, bot);
        return { text, status: status ?? { state: 'completed' } };
      };
      ctx.provide(Contracts.assistantRunner, assistantRunner({ clock: ctx.clock, texts, bots, turn: runnerTurn, work: runnerWork }));
      const directory = bots();
      if (directory !== undefined) {
        ctx.registerTool(createBotTool(directory, { korean, now: () => ctx.clock.now(), control: () => ctx.tryUse(Contracts.llmControl), compose, refine }));
        ctx.registerTool(delegateTool({ ctx, bots: directory, runBotTurn: async (bot, message) => await work(message, bot) }));
        // bots that find their own work once a day (owner can turn it off: bots.initiative)
        const initiative = new Initiative(ctx, korean);
        ctx.registerTool(initiativeTool(initiative));
        ctx.scheduler.add({ name: 'bots.initiative', label: korean ? '팀이 스스로 일 찾기' : 'Teams find their own work', schedule: { kind: 'every', seconds: 900 }, run: (now) => initiative.tick(now).then(() => undefined) });
      }
      ctx.registerHandler(handler);
    },
  };
}
