import { z } from 'zod';
import type { Bot, BotDirectory, BotTeam } from '../../core/contracts/bots.js';
import { BOT_ID, botAddress } from '../../core/contracts/bots.js';
import type { IncomingMessage, LiveHandoff } from '../../core/conversation/types.js';
import type { BotReply } from './team-run.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool, Toolbox } from '../../core/tools/types.js';
import { Contracts as Contracts } from '../../core/contracts/index.js';
import type { LlmControl } from '../../core/contracts/llm-control.js';
import { buildTeam } from '../../core/bots/teams.js';
import type { Composer } from '../../core/bots/composition.js';
import { composedFields } from '../../core/bots/composition.js';

const MAX_TASK = 4000;

/** Added to the system prompt inside a bot's room: the same assistant, speaking as that specialist. */
export function personaSection(bot: Bot, korean: boolean): string {
  // the role prompt describes the work; the approval rules above it stay in force whatever it says
  const how = bot.instructions !== undefined && bot.instructions !== '' ? `\n${korean ? '일하는 방식' : 'How you work'}:\n${bot.instructions}` : '';
  return korean
    ? `## 지금 당신은 "${bot.name}"입니다\n하는 일: ${bot.role}${how}\n이 방에서는 이 역할 안에서만 답하고 일하세요. 역할 밖의 일이면 메인 대화(비서)에 부탁하라고 쉬운 말로 안내하세요. 위의 확인 규칙은 이 역할보다 늘 먼저예요.`
    : `## You are now "${bot.name}"\nRole: ${bot.role}${how}\nIn this room, answer and work only within this role. For anything else, tell the owner in plain words to ask the main assistant. The confirmation rules above always come first.`;
}

/** Added to the main chat's prompt: who can take a task. */
export function rosterSection(bots: readonly Bot[], korean: boolean): string | undefined {
  // leads first (they hand work to their staff), and not more than a page of them
  const active = bots.filter((bot) => bot.status !== 'off' && !isSystemRoom(bot.id)).sort((a, b) => Number(b.rank === 'lead') - Number(a.rank === 'lead')).slice(0, 40);
  if (active.length === 0) return undefined;
  const lines = active.map((bot) => `- ${bot.id} (${bot.name}): ${bot.role}`);
  return korean
    ? `## 전문 봇\n${lines.join('\n')}\n요청이 한 봇의 일에 분명히 맞으면 bots.delegate로 맡기고, 주인에게는 "○○ 봇에게 맡겼어요"처럼 한 문장으로 알리세요. 애매하면 직접 하세요.`
    : `## Specialist bots\n${lines.join('\n')}\nWhen a request clearly fits one bot's role, hand it over with bots.delegate and tell the owner in one sentence. When unsure, do it yourself.`;
}

/** Bots the owner tagged in a message ("@QA 봇 …", "@qa"), by name or id, with or without spaces. */
export function mentionedBots(text: string, bots: readonly Bot[]): Bot[] {
  if (!text.includes('@')) return [];
  const lower = text.toLowerCase();
  const escape = (part: string): string => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return bots.filter((bot) => {
    if (bot.status === 'off' || isSystemRoom(bot.id)) return false;
    return [bot.name, bot.id].some((name) => {
      // spaces in the name are optional ("@개발 직원 1", "@개발직원1"); "@qa" must not match inside "@qa-review" or "@qa2"
      const tokens = name.toLowerCase().trim().split(/\s+/).filter((token) => token !== '').map(escape);
      return tokens.length > 0 && new RegExp(`@${tokens.join('\\s*')}(?![a-z0-9-])`, 'u').test(lower);
    });
  });
}

/** Added to the main chat's prompt when the owner tagged bots: hand it over with a brief written for them. */
export function mentionSection(text: string, bots: readonly Bot[], korean: boolean): string | undefined {
  const tagged = mentionedBots(text, bots).slice(0, 3);
  if (tagged.length === 0) return undefined;
  const list = tagged.map((bot) => `- ${bot.id} (${bot.name}): ${bot.role}`).join('\n');
  return korean
    ? `## 주인이 @로 지목한 봇\n${list}\n이 요청은 직접 하지 말고 bots.delegate로 지목한 봇에게 맡기세요. task에는 주인의 말을 그대로 옮기지 말고, 그 봇이 혼자 해낼 수 있게 다시 쓴 지시서를 넣으세요: 목표, 필요한 배경(기억·회사 문서·인물 카드·앞선 대화에서), 할 것과 하지 말 것, 끝났다고 볼 기준, 보고 형식. 애매한 점이 결과를 크게 바꾸면 맡기기 전에 한 번만 물으세요. 주인에게는 누구에게 무엇을 맡겼는지 한두 문장으로 알려 주세요.`
    : `## Bots the owner tagged with @\n${list}\nDo not do this yourself: hand it to the tagged bot with bots.delegate. In task, do not forward the owner's words as is; write a brief it can do alone: the goal, the background it needs (memory, company docs, people, earlier turns), what to do and not do, what done looks like, and how to report. Ask once first only if an open point would change the result a lot. Tell the owner in one or two sentences who got what.`;
}

/**
 * What a bot's own turn cannot do: hand work to another bot (no chains), or set up lasting work by itself — new
 * routines, new bots, switching on autonomous loops. Those stay the owner's (and the main assistant's) to decide.
 */
const BOT_FORBIDDEN = new Set(['bots.delegate', 'bots.create', 'bots.initiative', 'dev.autopilot', 'routines.add', 'routines.remove', 'routines.pause']);

/** A bot turn never delegates again, so a chain of hand-offs cannot loop; nor can it schedule more work for itself. */
export function withoutDelegation(tools: Toolbox): Toolbox {
  return {
    list: () => tools.list().filter((tool) => !BOT_FORBIDDEN.has(tool.name)),
    execute: (name, input, call) =>
      BOT_FORBIDDEN.has(name)
        ? Promise.resolve({ status: 'rejected', reason: name === 'bots.delegate' ? 'a bot cannot hand work to another bot' : 'a bot cannot set up lasting work by itself; tell the owner what to set up' })
        : tools.execute(name, input, call),
  };
}

/** What a scheduled run (a routine) cannot do: schedule more of itself or switch on autonomous loops. */
const SCHEDULED_FORBIDDEN = new Set(['bots.create', 'bots.initiative', 'dev.autopilot', 'routines.add', 'routines.remove', 'routines.pause']);

export function forScheduledRun(tools: Toolbox): Toolbox {
  return {
    list: () => tools.list().filter((tool) => !SCHEDULED_FORBIDDEN.has(tool.name)),
    execute: (name, input, call) =>
      SCHEDULED_FORBIDDEN.has(name) ? Promise.resolve({ status: 'rejected', reason: 'a scheduled run cannot set up lasting work; tell the owner what to set up' }) : tools.execute(name, input, call),
  };
}

/** The assistant's own rooms ("ax 개선", its sub-sessions, ops): not specialists to hand the owner's work to. */
export const isSystemRoom = (id: string): boolean => /^ax-(dev|ops)(-|$)/.test(id);

const createInput = z.object({
  id: z.string().regex(BOT_ID).describe('Short lowercase id, e.g. "dev" or "hanbit-dev".'),
  name: z.string().min(1).max(40).describe('The name the owner sees, e.g. "개발 봇".'),
  role: z.string().min(1).max(200).describe('One plain sentence: what it does.'),
  group: z.string().regex(BOT_ID).optional().describe('Group id (a company or life area).'),
  groupLabel: z.string().min(1).max(40).optional().describe('Group name the owner sees, when the group is new.'),
  kind: z.enum(['general', 'dev']).default('general'),
});

export interface TeamOptions {
  korean: boolean;
  now: () => Date;
  control: () => LlmControl | undefined;
  compose?: Composer;
  /** Writes purpose-specific role prompts in the background. */
  refine?: (team: BotTeam) => void;
}

/** R16: a bot made in chat becomes a team lead with staff (and a reviewer on dev work), on the default tiers. */
export function createBotTool(bots: BotDirectory, team?: TeamOptions): Tool<z.infer<typeof createInput>, { id: string; name: string }> {
  return {
    name: 'bots.create',
    description: 'Create (or update) a specialist bot with its own room, when the owner asks for one.',
    input: createInput,
    effects: ['write'],
    describe: (value) => `Create bot ${value.name}: ${value.role}`,
    async run(value) {
      if (value.group !== undefined) await bots.upsertGroup({ id: value.group, label: value.groupLabel ?? value.group });
      const bot = await bots.upsert({
        id: value.id,
        name: value.name,
        role: value.role,
        kind: value.kind,
        origin: 'owner',
        ...(value.group !== undefined ? { group: value.group } : {}),
      });
      if (team !== undefined) {
        const group = value.group ?? 'mine';
        if (value.group === undefined) await bots.upsertGroup({ id: 'mine', label: team.korean ? '내 봇' : 'My bots' });
        const shape = { name: value.name.replace(/\s*봇$/, ''), purpose: value.role, kind: value.kind };
        const sized = team.compose === undefined ? {} : composedFields(await team.compose(shape));
        const built = await buildTeam(bots, { group, ...shape, ...sized, leadId: bot.id, origin: 'owner' }, team.korean, team.now(), team.control());
        team.refine?.(built);
      }
      return { id: bot.id, name: bot.name };
    },
  };
}

const delegateInput = z.object({
  bot: z.string().regex(BOT_ID).describe('Bot id from the specialist list.'),
  task: z
    .string()
    .min(1)
    .max(MAX_TASK)
    .describe(
      'A brief the bot can do alone, rewritten from the owner\'s words (not forwarded as is): the goal, the background it needs ' +
        '(from memory, company docs, people, earlier turns), what to do and not do, what done looks like, and how to report.',
    ),
});

export interface DelegateDeps {
  ctx: PluginContext;
  bots: BotDirectory;
  /** Runs one assistant turn in the bot's room and returns what it said (with a page it left for the owner, if any). */
  runBotTurn(bot: Bot, message: IncomingMessage): Promise<BotReply>;
}

/** The delegation's output; a page the bot left for the owner rides along the browser outputs' way (§22). */
export interface DelegateOutput {
  bot: string;
  summary: string;
  liveView?: 'browser-live';
  url?: string;
  handoff?: { reason: LiveHandoff['reason'] };
}

/**
 * Hands one task to a bot: the bot works in its own room (its own memory and persona, the same tools and policy), its
 * answer is posted there, and the main chat gets the summary back to tell the owner.
 */
export function delegateTool(deps: DelegateDeps): Tool<z.infer<typeof delegateInput>, DelegateOutput> {
  return {
    name: 'bots.delegate',
    description: 'Hand a task to a specialist bot. It works in its own room and reports back here.',
    input: delegateInput,
    effects: ['write'],
    timeoutMs: 30 * 60_000,
    describe: (value) => `Hand to ${value.bot}: ${value.task}`,
    async run(value) {
      const bot = await deps.bots.get(value.bot);
      if (bot === undefined || bot.status === 'off') throw new Error(`No active bot "${value.bot}"`);
      const who = { id: bot.id, name: bot.name };
      const { ctx } = deps;
      await ctx.bus.emit('bots.delegation', { bot: who, task: value.task, state: 'started' });
      await deps.bots.setStatus(bot.id, 'working', value.task.slice(0, 80));
      // the apps' task panel shows each hand-over while the bot works on it
      const board = ctx.tryUse(Contracts.workInProgress);
      const startedAt = ctx.clock.now().toISOString();
      const work = { id: `bot:${bot.id}:${ctx.clock.now().getTime()}`, kind: 'bot', title: `${bot.name} · ${value.task.split('\n')[0]?.slice(0, 60) ?? ''}`, startedAt, origin: { channelId: 'channel.app', address: botAddress(bot.id) } };
      const track = (status: 'running' | 'done' | 'failed', summary?: string): Promise<void> => board?.upsert({ ...work, status, updatedAt: ctx.clock.now().toISOString(), ...(summary !== undefined ? { summary: summary.slice(0, 300) } : {}) }).catch(() => undefined) ?? Promise.resolve();
      await track('running');
      const message: IncomingMessage = {
        id: `delegate:${ctx.clock.now().getTime()}`,
        conversation: { channelId: 'core.delegation', address: botAddress(bot.id) },
        authorId: 'assistant',
        // the task comes from the owner's own message in the main chat, passed on by the assistant
        fromOwner: true,
        text: value.task,
        receivedAt: ctx.clock.now(),
      };
      try {
        const { text: summary, live } = await deps.runBotTurn(bot, message);
        await ctx.bus.emit('bots.message', { bot: who, text: summary });
        await ctx.bus.emit('bots.delegation', { bot: who, task: value.task, state: 'done', summary: summary.slice(0, 300) });
        await track('done', summary);
        await ctx.tryUse(Contracts.workLog)?.add({ at: ctx.clock.now(), title: value.task, kind: 'delegation', bot: who, detail: summary.slice(0, 300) }).catch(() => undefined);
        if (live === undefined) return { bot: bot.name, summary };
        return { bot: bot.name, summary, liveView: live.view, handoff: { reason: live.reason }, ...(live.url !== undefined ? { url: live.url } : {}) };
      } catch (error) {
        await ctx.bus.emit('bots.delegation', { bot: who, task: value.task, state: 'failed' });
        await track('failed', error instanceof Error ? error.message : undefined);
        throw error;
      } finally {
        await deps.bots.setStatus(bot.id, 'idle');
      }
    },
  };
}
