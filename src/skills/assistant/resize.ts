import type { BotDirectory, BotTeam } from '../../core/contracts/bots.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ResizeProposal } from '../../core/bots/team-health.js';
import { applyTeamTiers, refineInstructions, resizeTeam } from '../../core/bots/teams.js';

/**
 * R16: offers one resize of a team the harness sized, as a card (topic `team:resize:<id>`). A yes makes the new size the
 * owner's own (no more proposals for this team); a no is remembered by the topic.
 */
export async function proposeResize(ctx: PluginContext, directory: BotDirectory, team: BotTeam, proposal: ResizeProposal, korean: boolean): Promise<void> {
  const questions = ctx.tryUse(Contracts.questions);
  if (questions === undefined) return;
  const what = korean
    ? `직원 ${proposal.staffCount}명 · 검수 ${proposal.reviewerCount}명으로 바꾸기`
    : `${proposal.staffCount} staff and ${proposal.reviewerCount} reviewers`;
  const answer = await questions
    .ask({
      topic: `team:resize:${team.id}`,
      summary: korean ? `${team.name} 팀 인원을 바꿀까요?` : `Resize the ${team.name} team?`,
      note: korean ? `${team.name} 팀: ${proposal.why}. ${what}면 나아질 것 같아요.` : `${team.name}: ${proposal.why}. Suggest ${what}.`,
      choices: [
        { id: 'resize', label: what, tone: 'primary', detail: korean ? '봇이 늘어 조금 더 비싸져요' : 'Slightly more cost', means: 'approved' },
        { id: 'keep', label: korean ? '지금 그대로' : 'Keep as is', tone: 'danger', means: 'denied' },
        { id: 'later', label: korean ? '나중에' : 'Later', means: 'later' },
      ],
      askedBy: 'skill.assistant',
    })
    .catch(() => undefined);
  if (answer?.status !== 'answered' || answer.means !== 'approved') return;
  await resizeTeam(directory, team.id, proposal.staffCount, proposal.reviewerCount, korean, 'owner');
  const control = ctx.tryUse(Contracts.llmControl);
  const resized = (await directory.teams()).find((item) => item.id === team.id);
  if (control !== undefined && resized !== undefined) {
    await applyTeamTiers(resized, await directory.list(), control);
  }
  if (resized !== undefined) void refineInstructions(ctx.llm, directory, resized, korean).catch(() => 0);
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'bots.teams', text: korean ? `${team.name} 팀 인원을 바꿨어요 (${what.replace(/로 바꾸기$/, '')}).` : `Resized ${team.name}.` }).catch(() => undefined);
}
