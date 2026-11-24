import type { BotDirectory } from '../contracts/bots.js';
import { teamName } from '../contracts/bots.js';
import type { KnowledgeLine } from '../contracts/knowledge.js';
import type { LlmControl } from '../contracts/llm-control.js';
import { buildTeam } from './teams.js';
import type { Composer } from './composition.js';
import { composedFields } from './composition.js';

/**
 * R16/R18: after the first-look scan, every organisation the owner works in becomes a group with one work team, and
 * software projects get a dev team (with a reviewer). Default tiers; the owner changes them later. Never removes.
 */
const MAX_GROUPS = 4;
/** Projects the owner picked by hand: every one gets a team, up to this many. */
const MAX_PICKED_TEAMS = 24;
const COMPANY_KEY = 'company';
const MAX_DEV_TEAMS = 3;
const DEV_WORDS = /개발|코드|앱|서버|웹|프로그램|software|code|app\b|server|api|ios|android/i;

function name(text: string): string {
  return text.replace(/\s+/g, ' ').trim().split(/[,.·(]/)[0]?.slice(0, 20).trim() ?? '';
}

export function groupId(label: string, taken: ReadonlySet<string>): string {
  const ascii = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  const base = /^[a-z]/.test(ascii) && ascii.length >= 2 ? ascii : 'org';
  for (let n = 1; ; n += 1) {
    const id = n === 1 && base !== 'org' ? base : `${base}${n}`;
    if (!taken.has(id)) return id;
  }
}

export async function teamsFromScan(
  directory: BotDirectory,
  scan: { profile: readonly KnowledgeLine[]; projects: readonly KnowledgeLine[] },
  korean: boolean,
  now: Date,
  control?: LlmControl,
  compose?: Composer,
): Promise<number> {
  const picked = pickedProjects(scan.projects);
  if (picked.length > 0) return await teamsFromPicked(directory, picked, korean, now, control, compose);
  const sized = async (team: { name: string; purpose?: string; kind: 'general' | 'dev' }) => (compose === undefined ? {} : composedFields(await compose(team)));
  const groups = await directory.groups();
  const teams = await directory.teams();
  let made = 0;
  const orgs = [...new Set(scan.profile.filter((line) => line.topic === 'org').map((line) => name(line.key !== '' ? line.key : line.text)).filter((label) => label.length >= 2))].slice(0, MAX_GROUPS);
  let first: string | undefined;
  for (const label of orgs) {
    const existing = groups.find((group) => group.label === label);
    const id = existing?.id ?? groupId(label, new Set(groups.map((group) => group.id)));
    if (existing === undefined) {
      await directory.upsertGroup({ id, label, summary: korean ? '처음 문서 살펴보기에서 찾았어요' : 'Found in the first document scan' });
      groups.push({ id, label });
    }
    first ??= id;
    if (teams.some((team) => team.group === id)) continue;
    const work = { name: korean ? `${label} 업무` : `${label} work`, purpose: korean ? `${label}의 일` : `work at ${label}`, kind: 'general' as const };
    teams.push(await buildTeam(directory, { group: id, ...work, ...(await sized(work)), origin: 'onboarding' }, korean, now, control));
    made += 1;
  }
  const projects = new Map<string, string>();
  for (const line of scan.projects) if (DEV_WORDS.test(`${line.topic} ${line.text}`)) projects.set(line.topic, line.text);
  let dev = 0;
  for (const [project, text] of projects) {
    if (dev >= MAX_DEV_TEAMS) break;
    const label = name(project);
    if (label.length < 2 || teams.some((team) => team.name.startsWith(label))) continue;
    if (first === undefined) {
      first = 'mine';
      await directory.upsertGroup({ id: 'mine', label: korean ? '내 봇' : 'My bots' });
    }
    const devTeam = { name: label, purpose: text.slice(0, 200), kind: 'dev' as const };
    teams.push(await buildTeam(directory, { group: first, ...devTeam, ...(await sized(devTeam)), origin: 'onboarding' }, korean, now, control));
    made += 1;
    dev += 1;
  }
  return made;
}

/** One team the onboarding hierarchy proposes: shown to the owner, edited in the app, then built. */
export interface PlannedTeam {
  company: string;
  name: string;
  purpose: string;
  kind: 'dev' | 'general';
  /** From "role", "role-2"… lines: "시안 정리 — 시안을 모아 비교표로 만들어요". */
  roles: { title: string; does: string }[];
  /** From "tasks", "tasks-2"… lines: what keeps recurring in this work. */
  tasks: string[];
}

type Picked = PlannedTeam;

/** Projects the owner picked carry a "company" line (onboarding hierarchy); the order is the scan's. */
export function planFromScan(lines: readonly KnowledgeLine[]): PlannedTeam[] {
  return pickedProjects(lines);
}

function pickedProjects(lines: readonly KnowledgeLine[]): Picked[] {
  const out: Picked[] = [];
  for (const line of lines) {
    if (line.key !== COMPANY_KEY || line.text.trim() === '') continue;
    if (out.some((item) => item.name === line.topic)) continue;
    const own = lines.filter((other) => other.topic === line.topic);
    const purpose = own.find((other) => other.key === 'purpose')?.text ?? '';
    const kindLine = own.find((other) => other.key === 'kind')?.text;
    // Before the work map, a picked project was always a code project.
    const kind = kindLine === 'general' || kindLine === 'dev' ? kindLine : own.some((other) => other.key === 'stack') || kindLine === undefined ? 'dev' : 'general';
    const roles = own
      .filter((other) => /^role(-\d+)?$/.test(other.key))
      .map((other) => {
        const [title = '', ...rest] = other.text.split(' — ');
        return { title: title.trim(), does: rest.join(' — ').trim() };
      })
      .filter((role) => role.title !== '');
    const tasks = own.filter((other) => /^tasks(-\d+)?$/.test(other.key)).map((other) => other.text.trim()).filter((task) => task !== '');
    out.push({ company: line.text.trim(), name: line.topic, purpose, kind, roles, tasks });
  }
  return out;
}

/**
 * The owner's own company → project hierarchy: one group per company with a work team, and one dev team per picked
 * project inside its company. Existing groups and teams with the same name are kept, never duplicated.
 */
/** Builds the planned groups and teams (the owner approved the plan); existing names are kept, never duplicated. */
export async function applyPlan(
  directory: BotDirectory,
  planned: readonly PlannedTeam[],
  korean: boolean,
  now: Date,
  control?: LlmControl,
  compose?: Composer,
): Promise<number> {
  // the owner approved exactly these teams: no extra company-wide team on top
  return await teamsFromPicked(directory, planned, korean, now, control, compose, false);
}

async function teamsFromPicked(
  directory: BotDirectory,
  picked: readonly Picked[],
  korean: boolean,
  now: Date,
  control?: LlmControl,
  compose?: Composer,
  companyTeam = true,
): Promise<number> {
  const sized = async (team: { name: string; purpose?: string; kind: 'general' | 'dev' }) => (compose === undefined ? {} : composedFields(await compose(team)));
  const groups = await directory.groups();
  const teams = await directory.teams();
  const groupOf = new Map<string, string>();
  let made = 0;
  for (const company of [...new Set(picked.map((item) => item.company))]) {
    const label = company.slice(0, 40);
    const existing = groups.find((group) => group.label === label);
    const id = existing?.id ?? groupId(label, new Set(groups.map((group) => group.id)));
    if (existing === undefined) {
      await directory.upsertGroup({ id, label, summary: korean ? '처음 알아보기에서 고른 회사예요' : 'A company picked in the first look' });
      groups.push({ id, label });
    }
    groupOf.set(company, id);
    if (!companyTeam || teams.some((team) => team.group === id && team.kind !== 'dev')) continue;
    // A company whose projects all have their own teams needs no extra general team.
    if (picked.filter((item) => item.company === company).every((item) => item.kind === 'general')) continue;
    const work = { name: korean ? `${label} 업무` : `${label} work`, purpose: korean ? `${label}의 일` : `work at ${label}`, kind: 'general' as const };
    teams.push(await buildTeam(directory, { group: id, ...work, ...(await sized(work)), origin: 'onboarding' }, korean, now, control));
    made += 1;
  }
  for (const project of picked.slice(0, MAX_PICKED_TEAMS)) {
    const group = groupOf.get(project.company);
    const label = teamName(project.name);
    if (group === undefined || teams.some((team) => team.group === group && team.name === label)) continue;
    const projectTeam = { name: label, purpose: project.purpose.slice(0, 200) || label, kind: project.kind };
    const roles = project.roles.length > 0 ? { roles: project.roles } : {};
    teams.push(await buildTeam(directory, { group, ...projectTeam, ...(await sized(projectTeam)), ...roles, origin: 'onboarding' }, korean, now, control));
    made += 1;
  }
  return made;
}
