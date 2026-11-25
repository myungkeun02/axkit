import { Contracts } from '../../core/contracts/index.js';
import type { KnowledgeLine, ScanResult } from '../../core/contracts/knowledge.js';
import type { OrgUnit, RoutineProposal } from '../../core/contracts/org.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Activity } from './activity.js';
import type { CachedSummary } from './cache.js';
import type { OnboardingTexts } from './locale.js';
import type { OrgMap, OrgRelation } from './org-map.js';
import { buildOrgMap } from './org-map.js';
import { findRecurring } from './recurring.js';
import type { RosterEntry } from './roster.js';
import { buildRoster, top } from './roster.js';
import type { RoutineTeam } from './routine-proposals.js';
import { proposeRoutines } from './routine-proposals.js';

export interface OrgOutcome {
  units: OrgUnit[];
  routines: RoutineProposal[];
  /** One "people" knowledge line per unit, so the assistant knows who is where. */
  lines: KnowledgeLine[];
  /** People cards written or updated. */
  people: number;
}

const MAX_CARDS = 300;
const EMPLOYER = /\((다니는 곳|내 사업|employer|own)\)/;

/** The organisations the profile already names, the owner's own ones first: "에이컴퍼니 (다니는 곳): …" → 에이컴퍼니. */
export function knownOrgs(profile: readonly KnowledgeLine[]): string[] {
  const orgs = profile.filter((line) => line.topic === 'org');
  const ordered = [...orgs.filter((line) => EMPLOYER.test(line.text)), ...orgs.filter((line) => !EMPLOYER.test(line.text))];
  return [...new Set(ordered.map((line) => (line.key !== '' ? line.key : line.text.split(/[(:]/)[0] ?? '').trim()).filter((name) => name.length >= 2))];
}

function relationText(relation: OrgRelation | undefined, team: string | undefined, lead: boolean, korean: boolean): string | undefined {
  const where = team !== undefined ? (korean ? ` · ${team}${lead ? ' 리드' : ''}` : ` · ${team}${lead ? ' lead' : ''}`) : '';
  if (relation === 'employer' || relation === 'own') return korean ? `같은 회사 동료${where}` : `colleague${where}`;
  if (relation === 'client') return korean ? `고객사 담당자${where}` : `client contact${where}`;
  if (relation === 'partner') return korean ? `협력사 담당자${where}` : `partner contact${where}`;
  return undefined;
}

function evidenceNote(entry: RosterEntry, korean: boolean): string {
  const parts: string[] = [];
  if (entry.docs > 0) parts.push(korean ? `문서 ${entry.docs}개${entry.sources[0] !== undefined ? `(${entry.sources[0]} 등)` : ''}` : `${entry.docs} documents`);
  if (entry.mail > 0) parts.push(korean ? `메일 ${entry.mail}통` : `${entry.mail} mails`);
  if (entry.meetings > 0) parts.push(korean ? `회의 ${entry.meetings}번` : `${entry.meetings} meetings`);
  return korean ? `처음 알아보기: ${parts.join(' · ')}에서 봤어요.` : `First look: seen in ${parts.join(', ')}.`;
}

/** Fills each person's card from what the scan saw; the owner's own edits are never overwritten. */
async function writeCards(ctx: PluginContext, roster: readonly RosterEntry[], map: OrgMap, employer: string | undefined, korean: boolean): Promise<number> {
  const writer = ctx.tryUse(Contracts.peopleWrite);
  if (writer?.fillFromScan === undefined) return 0;
  let written = 0;
  for (const entry of roster.slice(0, MAX_CARDS)) {
    const unit = map.placed.get(entry.name);
    const team = unit?.name ?? top(entry.units);
    const company = unit?.org ?? top(entry.orgs) ?? (entry.internal ? employer : undefined);
    const relation = relationText(company !== undefined ? (map.relations.get(company) ?? (company === employer ? 'employer' : undefined)) : undefined, team, unit?.lead === entry.name, korean);
    const title = top(entry.titles);
    try {
      await writer.fillFromScan(
        { name: entry.name, ...(entry.emails[0] !== undefined ? { email: entry.emails[0] } : {}) },
        { ...(title !== undefined ? { title } : {}), ...(company !== undefined ? { company } : {}), ...(team !== undefined ? { team } : {}), ...(relation !== undefined ? { relation } : {}), note: evidenceNote(entry, korean) },
      );
      written += 1;
    } catch (error) {
      ctx.log.warn('onboarding: a person card could not be written', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  return written;
}

function unitLine(unit: OrgUnit, at: string, korean: boolean): KnowledgeLine {
  const head = `${unit.name}${unit.parent !== undefined ? (korean ? ` (${unit.parent} 아래)` : ` (under ${unit.parent})`) : ''}`;
  const lead = unit.lead !== undefined ? (korean ? ` · 리드 ${unit.lead}` : ` · lead ${unit.lead}`) : '';
  const members = unit.members.length > 0 ? (korean ? ` · ${unit.members.length}명: ${unit.members.slice(0, 12).join(', ')}${unit.members.length > 12 ? ' 외' : ''}` : ` · ${unit.members.length}: ${unit.members.slice(0, 12).join(', ')}`) : '';
  const purpose = unit.purpose !== undefined ? ` — ${unit.purpose}` : '';
  return { area: 'people', topic: korean ? `${unit.org} 조직` : `${unit.org} organisation`, key: `unit:${unit.name}`, text: `${head}${lead}${members}${purpose}`, sources: [...unit.sources], at };
}

/** Teams a routine can belong to: the units found, then the projects of the scan. */
function routineTeams(units: readonly OrgUnit[], projects: readonly KnowledgeLine[]): RoutineTeam[] {
  const teams: RoutineTeam[] = units.map((unit) => ({ company: unit.org, name: unit.name, ...(unit.purpose !== undefined ? { purpose: unit.purpose } : {}) }));
  for (const line of projects) {
    if (line.key !== 'company' || teams.some((team) => team.name === line.topic)) continue;
    const purpose = projects.find((other) => other.topic === line.topic && other.key === 'purpose')?.text;
    teams.push({ company: line.text, name: line.topic, ...(purpose !== undefined ? { purpose: purpose.slice(0, 120) } : {}) });
  }
  return teams;
}

/**
 * People, the real department and team structure, and the recurring work, from every document read plus mail and
 * calendar. Cards and units are saved for the 사람 tab; units and routines go on to the team plan for the owner's yes.
 */
export async function buildOrg(
  step: { ctx: PluginContext; texts: OnboardingTexts; summaries: readonly CachedSummary[]; activity?: Activity; result: ScanResult; now: Date },
): Promise<OrgOutcome> {
  const { ctx, texts } = step;
  const korean = ctx.assistant.language !== 'en';
  const roster = buildRoster(step.summaries, step.activity);
  const orgs = knownOrgs(step.result.profile);
  const map = await buildOrgMap({ llm: ctx.llm, log: ctx.log, texts }, { roster, summaries: step.summaries, knownOrgs: orgs });
  const people = await writeCards(ctx, roster, map, orgs[0], korean);
  const units: OrgUnit[] = map.units;
  await ctx.tryUse(Contracts.peopleWrite)?.setUnits?.(units).catch(() => undefined);
  const found = findRecurring({ ...(step.activity !== undefined ? { activity: step.activity } : {}), summaries: step.summaries }, step.now, ctx.assistant.timezone, korean);
  const routines = await proposeRoutines({ llm: ctx.llm, log: ctx.log, texts, korean }, found, routineTeams(units, step.result.projects));
  const at = step.now.toISOString();
  ctx.log.info('onboarding: org and routines found', { people, units: units.length, recurring: found.length, routines: routines.length, by: map.by });
  return { units, routines, lines: units.map((unit) => unitLine(unit, at, korean)), people };
}
