import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { guardText } from '../../core/text/data.js';

/** The rules first: if anything is cut, it is the introduction, not what the bots must follow. */
const SECTIONS = ['policies', 'about', 'products'] as const;
const MAX_SECTION = 900;
const MAX = 2400;

/**
 * The company documents (소개·제품·규칙) for every turn, the main chat and each bot's room, so a team bot follows the
 * company rules and knows who is who without being told again.
 */
export async function companySection(ctx: PluginContext, korean: boolean, teamId?: string): Promise<string | undefined> {
  const docs = ctx.tryUse(Contracts.docs);
  if (docs === undefined) return undefined;
  const parts: string[] = [];
  for (const section of SECTIONS) {
    const doc = await docs.get(`company:${section}`).catch(() => undefined);
    if (doc !== undefined && doc.body.trim() !== '') parts.push(`### ${doc.title}\n${guardText('company_doc', doc.body.trim()).slice(0, MAX_SECTION)}`);
  }
  // a bot's room also gets its own team's doc (what the team is for, who is in it)
  const team = teamId !== undefined ? await docs.get(`company:team:${teamId}`).catch(() => undefined) : undefined;
  if (team !== undefined && team.body.trim() !== '') parts.push(`### ${team.title}\n${guardText('team_doc', team.body.trim()).slice(0, MAX_SECTION)}`);
  if (parts.length === 0) return undefined;
  const title = korean ? '## 회사 문서 (주인이 알려 준 것; 회사 규칙은 지켜요)' : "## Company documents (from the owner; follow the company rules)";
  return `${title}\n${parts.join('\n\n').slice(0, MAX)}`;
}
