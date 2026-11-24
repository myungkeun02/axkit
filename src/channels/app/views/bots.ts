import { z } from 'zod';
import type { Bot, BotDirectory, BotTeam, TierLetter } from '../../../core/contracts/bots.js';
import { BOT_ID, meetingChannel } from '../../../core/contracts/bots.js';
import type { AppView } from '../../../core/contracts/device-api.js';
import { ViewInputError, ownerInputError } from '../../../core/contracts/device-api.js';
import type { LlmControl } from '../../../core/contracts/llm-control.js';
import { buildTeam, membersOf, setTeamTiers, tierOfBot } from '../../../core/bots/teams.js';
import type { Composer } from '../../../core/bots/composition.js';
import { checkInstructions, defaultInstructions } from '../../../core/bots/instructions.js';
import { composedFields } from '../../../core/bots/composition.js';

export interface BotsViewOptions {
  directory: BotDirectory;
  assistant: { name: string; language: string };
  avatarOf?: (botId: string) => Promise<string | undefined>;
  control?: () => LlmControl | undefined;
  /** Opens a lead meeting (R17); runs in the background. */
  requestMeeting?: (group: string, topic: string) => Promise<void>;
  /** The team-composition harness, for `auto:true`. */
  compose?: Composer;
  /** Role prompts for the team's purpose, written in the background. */
  refine?: (team: BotTeam) => void;
  now: () => Date;
}

const letter = z.enum(['S', 'A', 'B', 'C']);
const createSchema = z.object({
  group: z.string().regex(BOT_ID).optional(),
  newGroupLabel: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(30),
  purpose: z.string().trim().max(200).optional(),
  kind: z.enum(['dev', 'general']).default('general'),
  tiers: z.object({ lead: letter, staff: letter, reviewer: letter.optional() }).partial().default({}),
  staffCount: z.number().int().min(1).max(6).optional(),
  reviewerCount: z.number().int().min(0).max(3).optional(),
  auto: z.boolean().optional(),
});
const tiersSchema = z.object({ teamId: z.string().min(1).max(40), tiers: z.object({ lead: letter, staff: letter, reviewer: letter }).partial() });
const instructionsSchema = z.object({ botId: z.string().regex(BOT_ID), text: z.string().max(4000).nullable() });
const meetingSchema = z.object({ group: z.string().regex(BOT_ID), topic: z.string().trim().min(1).max(500) });

function newGroupId(label: string, taken: ReadonlySet<string>): string {
  const ascii = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  const base = /^[a-z]/.test(ascii) && ascii.length >= 2 ? ascii : 'co';
  for (let n = 1; ; n += 1) {
    const id = n === 1 && base !== 'co' ? base : `${base}${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * View "bots" (R1, R16, R17): the main assistant, then the owner's groups (a company, a life area) with their teams,
 * each team's lead, staff and reviewer with their tier letter, and the group's lead meeting room.
 */
export function botsView(options: BotsViewOptions): AppView {
  const { directory, assistant } = options;
  const korean = assistant.language !== 'en';
  return {
    name: 'bots',
    version: 1,
    async read() {
      const [bots, groups, teams] = await Promise.all([directory.list(), directory.groups(), directory.teams()]);
      const dayAgo = options.now().getTime() - 86_400_000;
      const avatars = new Map(await Promise.all(bots.map(async (bot) => [bot.id, await options.avatarOf?.(bot.id)] as const)));
      const teamOf = new Map(teams.map((team) => [team.id, team]));
      const view = (bot: Bot) => {
        const team = bot.team !== undefined ? teamOf.get(bot.team) : undefined;
        return {
          id: bot.id,
          name: bot.name,
          role: bot.role,
          channel: bot.id,
          status: bot.status,
          ...(avatars.get(bot.id) !== undefined ? { avatar: avatars.get(bot.id) } : {}),
          ...(bot.statusText !== undefined ? { statusText: bot.statusText } : {}),
          ...(bot.rank !== undefined ? { rank: bot.rank } : {}),
          ...(bot.instructions !== undefined ? { instructions: bot.instructions, instructionsBy: bot.instructionsBy ?? 'default' } : {}),
          ...(team !== undefined ? { team: team.id, tier: tierOfBot(team, bot) } : {}),
          ...(Date.parse(bot.createdAt) > dayAgo ? { isNew: true } : {}),
        };
      };
      const teamView = (team: BotTeam) => ({
        id: team.id,
        name: team.name,
        ...(team.purpose !== undefined ? { purpose: team.purpose } : {}),
        channel: team.id,
        kind: team.kind,
        tiers: team.tiers,
        members: membersOf(team, bots).filter((bot) => bot.status !== 'off').map((bot) => bot.id),
        staffCount: team.staffCount ?? membersOf(team, bots).filter((bot) => bot.rank === 'staff' && bot.status !== 'off').length,
        reviewerCount: team.reviewerCount ?? membersOf(team, bots).filter((bot) => bot.rank === 'reviewer' && bot.status !== 'off').length,
        decidedBy: team.decidedBy ?? 'owner',
        ...(team.reason !== undefined ? { reason: team.reason } : {}),
      });
      const known = new Set(groups.map((group) => group.id));
      const out = groups
        .map((group) => {
          const mine = teams.filter((team) => team.group === group.id);
          return {
            id: group.id,
            label: group.label,
            ...(group.summary !== undefined ? { summary: group.summary } : {}),
            ...(mine.length > 0 ? { meetingChannel: meetingChannel(group.id), teams: mine.map(teamView) } : {}),
            bots: bots.filter((bot) => bot.group === group.id).map(view),
          };
        })
        .filter((group) => group.bots.length > 0);
      const loose = bots.filter((bot) => bot.group === undefined || !known.has(bot.group));
      if (loose.length > 0) out.push({ id: 'general', label: korean ? '기타' : 'Other', bots: loose.map(view) });
      return {
        main: { name: assistant.name, subtitle: korean ? '무엇이든 먼저 여기에 말하세요' : 'Start here with anything' },
        groups: out,
      };
    },
    actions: {
      async createTeam(body) {
        const parsed = createSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('createTeam needs {group or newGroupLabel, name, kind}');
        const input = parsed.data;
        const groups = await directory.groups();
        let group = input.group;
        if (group === undefined || !groups.some((item) => item.id === group)) {
          if (input.newGroupLabel === undefined) throw ownerInputError(korean ? '어느 회사(묶음)에 만들지 알려 주세요' : 'Which group?');
          group = newGroupId(input.newGroupLabel, new Set(groups.map((item) => item.id)));
          await directory.upsertGroup({ id: group, label: input.newGroupLabel });
        }
        const tiers: Partial<Record<'lead' | 'staff' | 'reviewer', TierLetter>> = Object.fromEntries(Object.entries(input.tiers).filter(([, value]) => value !== undefined));
        const base = { group, name: input.name, ...(input.purpose !== undefined ? { purpose: input.purpose } : {}), kind: input.kind, origin: 'owner' as const };
        // auto: the harness sizes it (rule-checked); otherwise the owner's counts and tiers as given
        const sized =
          input.auto === true && options.compose !== undefined
            ? composedFields(await options.compose({ name: input.name, ...(input.purpose !== undefined ? { purpose: input.purpose } : {}), kind: input.kind }))
            : {
                tiers,
                decidedBy: 'owner' as const,
                ...(input.staffCount !== undefined ? { staffCount: input.staffCount } : {}),
                ...(input.reviewerCount !== undefined ? { reviewerCount: input.reviewerCount } : {}),
              };
        const team = await buildTeam(
          directory,
          { ...base, ...sized },
          korean,
          options.now(),
          options.control?.(),
        );
        options.refine?.(team);
        return { teamId: team.id, channel: team.id, group, decidedBy: team.decidedBy ?? 'owner', ...(team.reason !== undefined ? { reason: team.reason } : {}) };
      },
      /** The owner's own role prompt for one bot ({text: null} goes back to the template). Never replaced by AI. */
      async setInstructions(body) {
        const parsed = instructionsSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('setInstructions needs {botId, text}');
        const bot = await directory.get(parsed.data.botId);
        if (bot === undefined) throw ownerInputError(korean ? '그런 봇이 없어요' : 'No such bot');
        if (parsed.data.text === null) {
          const team = bot.team === undefined ? undefined : (await directory.teams()).find((item) => item.id === bot.team);
          const text = team === undefined ? bot.role : defaultInstructions(team, bot, korean);
          await directory.setInstructions(bot.id, text, 'default');
          return { botId: bot.id, instructions: text, instructionsBy: 'default' };
        }
        const checked = checkInstructions(parsed.data.text);
        if (!checked.ok) {
          throw ownerInputError(
            checked.reason === 'loosens_rules'
              ? korean ? '결재 없이 하라는 내용은 넣을 수 없어요. 보내기·결제·삭제는 늘 확인을 받아요.' : 'A role prompt cannot remove approvals.'
              : checked.reason === 'too_short' ? (korean ? '조금 더 자세히 적어 주세요.' : 'Too short.') : (korean ? 'AI에게 내리는 숨은 지시처럼 보이는 줄이 있어요.' : 'Looks like a hidden instruction.'),
          );
        }
        await directory.setInstructions(bot.id, checked.text, 'owner');
        return { botId: bot.id, instructions: checked.text, instructionsBy: 'owner' };
      },
      async setTiers(body) {
        const parsed = tiersSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('setTiers needs {teamId, tiers}');
        const tiers = Object.fromEntries(Object.entries(parsed.data.tiers).filter(([, value]) => value !== undefined));
        const team = await setTeamTiers(directory, parsed.data.teamId, tiers, options.control?.());
        if (team === undefined) throw ownerInputError(korean ? '그런 팀이 없어요' : 'No such team');
        return { teamId: team.id, tiers: team.tiers };
      },
      async meeting(body) {
        const parsed = meetingSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('meeting needs {group, topic}');
        const teams = (await directory.teams()).filter((team) => team.group === parsed.data.group);
        if (teams.length === 0 || options.requestMeeting === undefined) throw ownerInputError(korean ? '이 묶음에는 아직 팀이 없어요' : 'This group has no teams yet');
        await options.requestMeeting(parsed.data.group, parsed.data.topic);
        return { channel: meetingChannel(parsed.data.group), started: true };
      },
    },
  };
}
