import { z } from 'zod';
import type { PlanTeam } from './team-plan.js';
import { ScheduleSchema as Schedule, scheduleText } from './team-plan.js';

export const RELATIONS = ['employer', 'own', 'client', 'partner', 'personal'] as const;
export type Relation = (typeof RELATIONS)[number];
export const RELATION_KO: Readonly<Record<Relation, string>> = { employer: '다니는 곳', own: '내 사업', client: '고객사', partner: '협력사', personal: '개인' };
const RELATION_EN: Readonly<Record<Relation, string>> = { employer: 'employer', own: 'own business', client: 'client', partner: 'partner', personal: 'personal' };

const MAX_TEAMS = 24;
const MAX_ROLES = 6;
const MAX_ROUTINES = 5;

/** What the model may ask for. References are "P3" / "C1" (or the exact existing name); new names only where noted. */
export const EditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move_project'), project: z.string(), to: z.string() }),
  z.object({ op: z.literal('rename_company'), company: z.string(), to: z.string() }),
  z.object({ op: z.literal('merge_companies'), companies: z.array(z.string()).min(1).max(10), into: z.string() }),
  z.object({ op: z.literal('rename_project'), project: z.string(), to: z.string() }),
  z.object({ op: z.literal('drop_project'), project: z.string() }),
  z.object({ op: z.literal('add_project'), name: z.string(), company: z.string(), purpose: z.string().default(''), kind: z.enum(['dev', 'general']).catch('general') }),
  z.object({ op: z.literal('add_role'), project: z.string(), title: z.string(), does: z.string().default('') }),
  z.object({ op: z.literal('remove_role'), project: z.string(), title: z.string() }),
  z.object({ op: z.literal('add_routine'), project: z.string(), title: z.string(), instruction: z.string(), schedule: Schedule }),
  z.object({ op: z.literal('remove_routine'), project: z.string(), title: z.string() }),
  z.object({ op: z.literal('set_relation'), company: z.string(), relation: z.enum(RELATIONS) }),
  z.object({ op: z.literal('set_kind'), project: z.string(), kind: z.enum(['dev', 'general']) }),
]);
export type PlanEdit = z.infer<typeof EditSchema>;

export interface EditInput {
  teams: readonly PlanTeam[];
  relations: Readonly<Record<string, Relation>>;
  /** The owner's own sentence: a new project or company name must appear in it. */
  instruction: string;
  korean: boolean;
}

export interface EditOutcome {
  teams: PlanTeam[];
  relations: Record<string, Relation>;
  /** Project (current name) → company it now sits under, for every project whose company changed. */
  moved: Map<string, string>;
  /** Old project name → new name. */
  renamed: Map<string, string>;
  changed: string[];
  skipped: string[];
}

function squash(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

function clip(text: string, max: number): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, max);
}

/**
 * Applies the model's edit list to the proposed plan in code: every reference must resolve to a project or company that
 * is in the plan, a new project only when the owner named it, limits as in the plan schema. Each edit either applies
 * whole or lands in `skipped` with the reason.
 */
export function applyEdits(input: EditInput, edits: readonly PlanEdit[]): EditOutcome {
  const ko = input.korean;
  const teams = input.teams.map((team) => ({ ...team, roles: [...team.roles], routines: [...team.routines], tasks: [...team.tasks] }));
  const relations: Record<string, Relation> = { ...input.relations };
  const original = new Map(input.teams.map((team) => [team.name, team.company]));
  const renamed = new Map<string, string>();
  const changed: string[] = [];
  const skipped: string[] = [];
  const said = squash(input.instruction);
  const companies = (): string[] => [...new Set(teams.map((team) => team.company))];
  // "P3" / "C1" always mean the numbering the model was shown, however earlier edits changed the list.
  const shownTeams = [...teams];
  const shownCompanies = companies();
  const alias = new Map<string, string>();
  const project = (ref: string): PlanTeam | undefined => {
    const id = /^P(\d+)$/i.exec(ref.trim());
    const found = id !== null ? shownTeams[Number(id[1]) - 1] : teams.find((team) => squash(team.name) === squash(ref));
    return found !== undefined && teams.includes(found) ? found : undefined;
  };
  const company = (ref: string): string | undefined => {
    const id = /^C(\d+)$/i.exec(ref.trim());
    let name = id !== null ? shownCompanies[Number(id[1]) - 1] : companies().find((item) => squash(item) === squash(ref));
    for (let hops = 0; name !== undefined && alias.has(name) && hops < 20; hops += 1) name = alias.get(name);
    return name !== undefined && companies().includes(name) ? name : undefined;
  };
  /** An existing company, or a new name the owner said (or an existing project's name, "베타랩은 따로야"). */
  const target = (ref: string): string | undefined => {
    const found = company(ref);
    if (found !== undefined) return found;
    const name = clip(ref, 80);
    if (name === '' || /^[CP]\d+$/i.test(name)) return undefined;
    return said.includes(squash(name)) || teams.some((team) => squash(team.name) === squash(name)) ? name : undefined;
  };
  const skip = (what: string, why: string): void => void skipped.push(`${what} (${why})`);
  const noProject = ko ? '계획에 없는 프로젝트예요' : 'not in the plan';
  const noCompany = ko ? '계획에 없는 회사예요' : 'no such company';
  const carry = (from: string, to: string): void => {
    if (from !== to && relations[to] === undefined && relations[from] !== undefined) relations[to] = relations[from];
  };

  for (const edit of edits) {
    switch (edit.op) {
      case 'move_project': {
        const team = project(edit.project);
        const to = target(edit.to);
        if (team === undefined) skip(edit.project, noProject);
        else if (to === undefined) skip(edit.to, ko ? '말씀하신 적 없는 회사 이름이에요' : 'a company name you did not say');
        else if (team.company !== to) {
          const fresh = !companies().includes(to);
          carry(team.company, to);
          team.company = to;
          changed.push(ko ? `${team.name} → ${to}${fresh ? ' (따로 나눔)' : ' 아래로'}` : `${team.name} → ${to}`);
        }
        break;
      }
      case 'rename_company':
      case 'merge_companies': {
        const refs = edit.op === 'rename_company' ? [edit.company] : edit.companies;
        const from = refs.map(company);
        const into = edit.op === 'rename_company' ? clip(edit.to, 80) : target(edit.into);
        const missing = refs.find((_, index) => from[index] === undefined);
        if (missing !== undefined) skip(missing, noCompany);
        else if (into === undefined || into === '') skip(edit.op === 'rename_company' ? edit.to : edit.into, ko ? '새 이름이 없어요' : 'no new name');
        else {
          const names = [...new Set(from as string[])];
          for (const team of teams) if (names.includes(team.company)) team.company = into;
          for (const name of names) {
            carry(name, into);
            if (name !== into) alias.set(name, into);
          }
          if (edit.op === 'rename_company') changed.push(ko ? `회사 이름 ${names.join('·')} → ${into}` : `renamed ${names.join(', ')} to ${into}`);
          else changed.push(ko ? `${names.join('·')} 합쳐서 ${into}` : `merged ${names.join(', ')} into ${into}`);
        }
        break;
      }
      case 'rename_project': {
        const team = project(edit.project);
        const to = clip(edit.to, 60);
        if (team === undefined) skip(edit.project, noProject);
        else if (to === '' || teams.some((other) => other !== team && squash(other.name) === squash(to))) skip(edit.to, ko ? '이미 있는 이름이에요' : 'name taken');
        else {
          const before = [...renamed.entries()].find(([, now]) => now === team.name)?.[0] ?? team.name;
          changed.push(ko ? `프로젝트 이름 ${team.name} → ${to}` : `renamed ${team.name} to ${to}`);
          renamed.set(before, to);
          team.name = to;
        }
        break;
      }
      case 'drop_project': {
        const team = project(edit.project);
        if (team === undefined) skip(edit.project, noProject);
        else {
          teams.splice(teams.indexOf(team), 1);
          changed.push(ko ? `${team.name} 빼기` : `dropped ${team.name}`);
        }
        break;
      }
      case 'add_project': {
        const name = clip(edit.name, 60);
        const where = target(edit.company);
        if (name === '' || !said.includes(squash(name))) skip(edit.name, ko ? '말씀하신 적 없는 프로젝트라 만들지 않았어요' : 'you did not name it');
        else if (project(name) !== undefined) skip(name, ko ? '이미 있어요' : 'already there');
        else if (where === undefined) skip(edit.company, noCompany);
        else if (teams.length >= MAX_TEAMS) skip(name, ko ? `팀은 ${MAX_TEAMS}개까지예요` : `at most ${MAX_TEAMS} teams`);
        else {
          teams.push({ company: where, name, purpose: clip(edit.purpose, 300), kind: edit.kind, roles: [], tasks: [], routines: [] });
          changed.push(ko ? `${name} 추가 (${where})` : `added ${name} (${where})`);
        }
        break;
      }
      case 'add_role': {
        const team = project(edit.project);
        const title = clip(edit.title, 20);
        if (team === undefined) skip(edit.project, noProject);
        else if (title === '' || team.roles.some((role) => squash(role.title) === squash(title))) skip(edit.title, ko ? '이미 있는 역할이에요' : 'already there');
        else if (team.roles.length >= MAX_ROLES) skip(title, ko ? `역할은 ${MAX_ROLES}개까지예요` : `at most ${MAX_ROLES} roles`);
        else {
          team.roles.push({ title, does: clip(edit.does, 120) });
          changed.push(ko ? `${team.name}에 역할 '${title}' 추가` : `added role ${title} to ${team.name}`);
        }
        break;
      }
      case 'remove_role':
      case 'remove_routine': {
        const team = project(edit.project);
        const list = edit.op === 'remove_role' ? team?.roles : team?.routines;
        const index = list?.findIndex((item) => squash(item.title) === squash(edit.title)) ?? -1;
        if (team === undefined || list === undefined) skip(edit.project, noProject);
        else if (index < 0) skip(edit.title, ko ? '그런 항목이 없어요' : 'not there');
        else {
          list.splice(index, 1);
          const kind = edit.op === 'remove_role' ? (ko ? '역할' : 'role') : ko ? '루틴' : 'routine';
          changed.push(ko ? `${team.name}에서 ${kind} '${edit.title}' 빼기` : `removed ${kind} ${edit.title} from ${team.name}`);
        }
        break;
      }
      case 'add_routine': {
        const team = project(edit.project);
        const title = clip(edit.title, 60);
        const instruction = clip(edit.instruction, 1000);
        if (team === undefined) skip(edit.project, noProject);
        else if (title === '' || instruction === '') skip(edit.title, ko ? '내용이 비었어요' : 'empty');
        else if (team.routines.length >= MAX_ROUTINES) skip(title, ko ? `루틴은 ${MAX_ROUTINES}개까지예요` : `at most ${MAX_ROUTINES} routines`);
        else {
          team.routines.push({ title, instruction, schedule: edit.schedule });
          changed.push(ko ? `${team.name}에 루틴 '${title}' (${scheduleText(edit.schedule, true)}) 추가` : `added routine ${title} (${scheduleText(edit.schedule, false)}) to ${team.name}`);
        }
        break;
      }
      case 'set_relation': {
        const name = company(edit.company);
        if (name === undefined) skip(edit.company, noCompany);
        else {
          relations[name] = edit.relation;
          changed.push(`${name}: ${(ko ? RELATION_KO : RELATION_EN)[edit.relation]}`);
        }
        break;
      }
      case 'set_kind': {
        const team = project(edit.project);
        if (team === undefined) skip(edit.project, noProject);
        else if (team.kind !== edit.kind) {
          team.kind = edit.kind;
          changed.push(ko ? `${team.name}: ${edit.kind === 'dev' ? '개발팀' : '일반 팀'}` : `${team.name}: ${edit.kind === 'dev' ? 'dev team' : 'general team'}`);
        }
        break;
      }
    }
  }

  const moved = new Map<string, string>();
  for (const team of teams) {
    const before = [...renamed.entries()].find(([, now]) => now === team.name)?.[0] ?? team.name;
    const was = original.get(before);
    if (was !== undefined && was !== team.company) moved.set(team.name, team.company);
  }
  return { teams, relations, moved, renamed, changed, skipped };
}
