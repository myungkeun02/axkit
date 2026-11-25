import { z } from 'zod';
import type { Bot, BotDirectory } from '../../../core/contracts/bots.js';
import { ViewInputError } from '../../../core/contracts/device-api.js';

const name = z.string().trim().min(1).max(40);
const renameTeamSchema = z.object({ teamId: z.string().min(1).max(80), name, purpose: z.string().trim().max(200).optional() });
const editBotSchema = z.object({ botId: z.string().min(1).max(80), name: name.optional(), role: z.string().trim().min(2).max(120).optional() });
const moveBotSchema = z.object({ botId: z.string().min(1).max(80), teamId: z.string().min(1).max(80) });

function botInput(bot: Bot, patch: Partial<Bot>): Parameters<BotDirectory['upsert']>[0] {
  const { status: _status, statusText: _statusText, createdAt: _createdAt, ...rest } = bot;
  void _status;
  void _statusText;
  void _createdAt;
  return { ...rest, ...patch };
}

/**
 * Direct edits from the bot screen (no plan, no card: renaming and moving are reversible owner choices): a team's
 * name and purpose, a bot's name and role, and moving a member to another team. A team lead stays with its team.
 */
export function botEditActions(directory: BotDirectory, korean: boolean, ownerInputError: (message: string) => Error): Record<string, (body: unknown) => Promise<Record<string, unknown>>> {
  return {
    async renameTeam(body) {
      const parsed = renameTeamSchema.safeParse(body);
      if (!parsed.success) throw new ViewInputError('renameTeam needs {teamId, name, purpose?}');
      const team = (await directory.teams()).find((item) => item.id === parsed.data.teamId);
      if (team === undefined) throw ownerInputError(korean ? '그런 팀이 없어요' : 'No such team');
      await directory.upsertTeam({ ...team, name: parsed.data.name, ...(parsed.data.purpose !== undefined ? { purpose: parsed.data.purpose } : {}) });
      return { teamId: team.id, name: parsed.data.name };
    },
    async editBot(body) {
      const parsed = editBotSchema.safeParse(body);
      if (!parsed.success || (parsed.data.name === undefined && parsed.data.role === undefined)) throw new ViewInputError('editBot needs {botId, name?, role?}');
      const bot = await directory.get(parsed.data.botId);
      if (bot === undefined) throw ownerInputError(korean ? '그런 봇이 없어요' : 'No such bot');
      const saved = await directory.upsert(botInput(bot, { ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}), ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}) }));
      return { botId: saved.id, name: saved.name, role: saved.role };
    },
    async moveBot(body) {
      const parsed = moveBotSchema.safeParse(body);
      if (!parsed.success) throw new ViewInputError('moveBot needs {botId, teamId}');
      const bot = await directory.get(parsed.data.botId);
      if (bot === undefined) throw ownerInputError(korean ? '그런 봇이 없어요' : 'No such bot');
      const teams = await directory.teams();
      const target = teams.find((item) => item.id === parsed.data.teamId);
      if (target === undefined) throw ownerInputError(korean ? '그런 팀이 없어요' : 'No such team');
      if (teams.some((team) => team.lead === bot.id && team.id !== target.id)) {
        throw ownerInputError(korean ? '팀장은 옮길 수 없어요. 다른 사람을 옮기거나 팀 이름을 바꿔 주세요.' : 'A team lead stays with its team.');
      }
      const saved = await directory.upsert(botInput(bot, { team: target.id, group: target.group }));
      return { botId: saved.id, teamId: target.id };
    },
  };
}
