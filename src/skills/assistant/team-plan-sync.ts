import type { Composer } from '../../core/bots/composition.js';
import { applyPlan, groupId } from '../../core/bots/from-scan.js';
import type { BotDirectory } from '../../core/contracts/bots.js';
import { teamName } from '../../core/contracts/bots.js';
import type { LlmControl } from '../../core/contracts/llm-control.js';
import type { PlanTeam } from './team-plan.js';

export interface SyncResult {
  moved: number;
  renamed: number;
  added: number;
  /** Changes a built team cannot take by words (dropped projects, roles, routines): the app's team screen does them. */
  notApplied: string[];
}

const label = (company: string): string => company.slice(0, 40);

/**
 * After the teams were built, a correction in words still lands: a project moved to another company moves its team
 * (and its bots) to that company's group, a renamed project renames its team, a new project gets its team. Built teams
 * are never deleted by words.
 */
export async function syncBuiltTeams(
  directory: BotDirectory,
  before: readonly PlanTeam[],
  after: readonly PlanTeam[],
  renamed: ReadonlyMap<string, string>,
  opts: { korean: boolean; now: Date; control?: LlmControl; compose?: Composer },
): Promise<SyncResult> {
  const result: SyncResult = { moved: 0, renamed: 0, added: 0, notApplied: [] };
  const groups = await directory.groups();
  const ensureGroup = async (company: string): Promise<string> => {
    const existing = groups.find((group) => group.label === label(company));
    if (existing !== undefined) return existing.id;
    const id = groupId(label(company), new Set(groups.map((group) => group.id)));
    await directory.upsertGroup({ id, label: label(company), summary: opts.korean ? '말로 고친 회사예요' : 'A company set by the owner' });
    groups.push({ id, label: label(company) });
    return id;
  };
  const teams = await directory.teams();
  const bots = await directory.list();
  const fresh: PlanTeam[] = [];
  for (const planned of after) {
    const oldName = [...renamed.entries()].find(([, to]) => to === planned.name)?.[0] ?? planned.name;
    const was = before.find((team) => team.name === oldName);
    const built = was === undefined ? undefined : teams.find((team) => team.name === teamName(was.name) && groups.find((group) => group.id === team.group)?.label === label(was.company));
    if (built === undefined) {
      if (was === undefined) fresh.push(planned);
      continue;
    }
    const group = await ensureGroup(planned.company);
    const name = teamName(planned.name);
    if (built.group === group && built.name === name) continue;
    if (built.group !== group) result.moved += 1;
    if (built.name !== name) result.renamed += 1;
    await directory.upsertTeam({ ...built, group, name });
    for (const bot of bots.filter((item) => item.team === built.id)) {
      const botName = built.name !== name ? bot.name.replace(built.name, name) : bot.name;
      if (bot.group !== group || bot.name !== botName) await directory.upsert({ ...bot, group, name: botName });
    }
  }
  if (fresh.length > 0) {
    result.added = await applyPlan(directory, fresh, opts.korean, opts.now, opts.control, opts.compose);
  }
  for (const was of before) {
    const stillThere = after.some((team) => team.name === (renamed.get(was.name) ?? was.name));
    if (!stillThere) result.notApplied.push(opts.korean ? `'${was.name}' 팀 지우기 (앱의 팀 화면에서 지워요)` : `removing team ${was.name} (do it in the app)`);
  }
  return result;
}
