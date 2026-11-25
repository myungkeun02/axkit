import { z } from 'zod';
import type { BotDirectory } from '../../core/contracts/bots.js';
import { buildDescribedTeam, describeTeam } from '../../core/bots/describe-team.js';
import type { LlmGateway } from '../../core/llm/types.js';
import type { Tool } from '../../core/tools/types.js';
import type { TeamOptions } from './bots.js';

const input = z.object({
  description: z
    .string()
    .min(5)
    .max(6000)
    .describe("The owner's whole description of the team in their own words: what it does, members, style, channels, tools, schedule, rules. Pass it as said, not summarized."),
});

/** Tool "bots.create_team": the owner describes a team in one message and it is built with members and their brief. */
export function createTeamTool(llm: LlmGateway, bots: BotDirectory, team: TeamOptions): Tool<z.infer<typeof input>, Record<string, unknown>> {
  return {
    name: 'bots.create_team',
    description: 'Create a whole team from the owner\'s description ("영상 제작팀 만들어 줘: 유튜브 주 2편, 기획·대본·편집·썸네일…"). Use when the owner describes a team, its members or how it should work.',
    input,
    effects: ['write'],
    describe: (value) => `${team.korean ? '팀 만들기' : 'Create team'}: ${value.description.slice(0, 80)}`,
    async run(value) {
      const draft = await describeTeam(llm, value.description, team.korean);
      const control = team.control();
      const { team: built, briefKept } = await buildDescribedTeam(draft, undefined, {
        directory: bots,
        korean: team.korean,
        now: team.now(),
        ...(control !== undefined ? { control } : {}),
        ...(team.refine !== undefined ? { refine: team.refine } : {}),
      });
      const members = (await bots.list()).filter((bot) => bot.team === built.id).map((bot) => `${bot.name}: ${bot.role}`);
      return { teamId: built.id, name: built.name, purpose: built.purpose ?? draft.purpose, members, briefKept, room: built.id };
    },
  };
}
