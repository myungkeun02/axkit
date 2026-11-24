import type { Bot, BotDirectory, BotTeam, TeamTiers, TierLetter } from '../contracts/bots.js';
import { BOT_ID, DEFAULT_TIERS, teamName } from '../contracts/bots.js';
import type { LlmControl } from '../contracts/llm-control.js';
import type { LlmGateway, Tier } from '../llm/types.js';
import { defaultInstructions, draftInstructions } from './instructions.js';

/** R16: a team is one lead, staff under it (3 by default) and, on dev teams, a reviewer. Names are the server's. */
export interface TeamInput {
  group: string;
  name: string;
  purpose?: string;
  kind: 'general' | 'dev';
  tiers?: Partial<TeamTiers>;
  staffCount?: number;
  /** Default: 1 on dev teams, 0 otherwise. */
  reviewerCount?: number;
  decidedBy?: 'owner' | 'ai';
  reason?: string;
  /** The lead's id, when an existing bot becomes a team lead (a company team, a bot made in chat). */
  leadId?: string;
  origin: Bot['origin'];
  /**
   * What each staff member does, when the work is known ("시안 정리: 시안을 모아 비교표로 만들어요"). Staff are named
   * and prompted after these instead of "직원 1, 2, 3"; the count follows them.
   */
  roles?: readonly { title: string; does: string }[];
}

export const MAX_ROLE_TITLE = 20;

export const TIER_OF_LETTER: Record<TierLetter, Tier> = { S: 'deep', A: 'standard', B: 'fast', C: 'cheap' };

function slug(name: string, taken: ReadonlySet<string>): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 14);
  const base = ascii.length >= 2 ? ascii : 't';
  for (let n = 1; ; n += 1) {
    const id = n === 1 && base !== 't' ? base : `${base}${n}`;
    if (!taken.has(`team-${id}`)) return id;
  }
}

function texts(korean: boolean, name: string, purpose: string | undefined) {
  const what = purpose !== undefined && purpose !== '' ? purpose : name;
  return korean
    ? {
        lead: { name: `${name} 팀장`, role: `${what} 일을 직원에게 나눠 맡기고 결과를 모아 알려 드려요` },
        staff: (n: number) => ({ name: `${name} 직원 ${n}`, role: `${name} 팀장이 맡긴 일을 해요` }),
        reviewer: { name: `${name} 검수`, role: '만든 것을 꼼꼼히 확인하고 고칠 점을 알려 줘요' },
      }
    : {
        lead: { name: `${name} lead`, role: `Splits ${what} work among the staff and reports back` },
        staff: (n: number) => ({ name: `${name} staff ${n}`, role: `Does what the ${name} lead hands over` }),
        reviewer: { name: `${name} reviewer`, role: 'Checks the work carefully and says what to fix' },
      };
}

/** Members in order: lead, staff, reviewer. */
export function membersOf(team: BotTeam, bots: readonly Bot[]): Bot[] {
  const rank = { lead: 0, staff: 1, reviewer: 2 } as const;
  return bots.filter((bot) => bot.team === team.id).sort((a, b) => rank[a.rank ?? 'staff'] - rank[b.rank ?? 'staff'] || a.id.localeCompare(b.id));
}

export function tierOfBot(team: BotTeam, bot: Bot): TierLetter {
  if (bot.rank === 'lead') return team.tiers.lead;
  if (bot.rank === 'reviewer') return team.tiers.reviewer ?? DEFAULT_TIERS.reviewer ?? 'S';
  return team.tiers.staff;
}

/** Each member's turns run on its team role's tier (purpose "bot.<id>", R12). */
export async function applyTeamTiers(team: BotTeam, bots: readonly Bot[], control: LlmControl | undefined): Promise<void> {
  if (control === undefined) return;
  for (const bot of membersOf(team, bots)) await control.setPurpose(`bot.${bot.id}`, TIER_OF_LETTER[tierOfBot(team, bot)]);
}

export async function buildTeam(directory: BotDirectory, input: TeamInput, korean: boolean, now: Date, control?: LlmControl): Promise<BotTeam> {
  const existing = await directory.teams();
  const bots = await directory.list();
  const lead = input.leadId !== undefined ? existing.find((team) => team.lead === input.leadId) : undefined;
  if (lead !== undefined) return lead;
  const id = `team-${slug(input.name, new Set(existing.map((team) => team.id)))}`;
  const kind = input.kind;
  const roles = (input.roles ?? []).filter((role) => role.title.trim() !== '').slice(0, 6);
  const staffCount = Math.max(1, Math.min(6, roles.length > 0 ? roles.length : (input.staffCount ?? 3)));
  const reviewerCount = Math.max(0, Math.min(3, input.reviewerCount ?? (kind === 'dev' ? 1 : 0)));
  const tiers: TeamTiers = {
    lead: input.tiers?.lead ?? DEFAULT_TIERS.lead,
    staff: input.tiers?.staff ?? DEFAULT_TIERS.staff,
    ...(reviewerCount > 0 ? { reviewer: input.tiers?.reviewer ?? DEFAULT_TIERS.reviewer ?? 'S' } : {}),
  };
  const leadId = input.leadId !== undefined && BOT_ID.test(input.leadId) ? input.leadId : `${id.slice(5)}-lead`.slice(0, 31);
  const team: BotTeam = {
    id,
    group: input.group,
    name: teamName(input.name),
    ...(input.purpose !== undefined ? { purpose: input.purpose.slice(0, 200) } : {}),
    kind,
    tiers,
    lead: leadId,
    staffCount,
    reviewerCount,
    decidedBy: input.decidedBy ?? 'owner',
    ...(input.reason !== undefined ? { reason: input.reason.slice(0, 200) } : {}),
    createdAt: now.toISOString(),
  };
  const t = texts(korean, team.name, team.purpose);
  const common = { group: input.group, kind, origin: input.origin, team: id } as const;
  const previousLead = bots.find((bot) => bot.id === leadId);
  await directory.upsert({ id: leadId, name: previousLead?.name ?? t.lead.name, role: previousLead?.role ?? t.lead.role, ...common, rank: 'lead' });
  for (let n = 1; n <= staffCount; n += 1) {
    const role = roles[n - 1];
    const named = role === undefined ? t.staff(n) : { name: `${team.name} ${role.title.trim().slice(0, MAX_ROLE_TITLE)}`.slice(0, 40), role: role.does.trim().slice(0, 120) || t.staff(n).role };
    await directory.upsert({ id: `${id.slice(5)}-s${n}`.slice(0, 31), ...named, ...common, kind: 'general', rank: 'staff' });
  }
  for (let n = 1; n <= reviewerCount; n += 1) {
    const reviewer = n === 1 ? t.reviewer : { name: `${t.reviewer.name} ${n}`, role: t.reviewer.role };
    await directory.upsert({ id: `${id.slice(5)}-review${n === 1 ? '' : String(n)}`.slice(0, 31), ...reviewer, ...common, rank: 'reviewer' });
  }
  await directory.upsertTeam(team);
  await giveDefaultInstructions(directory, team, korean);
  await applyTeamTiers(team, await directory.list(), control);
  return team;
}

/** Every member without a role prompt gets the template for its rank; an AI or owner version is left alone. */
export async function giveDefaultInstructions(directory: BotDirectory, team: BotTeam, korean: boolean): Promise<void> {
  for (const bot of membersOf(team, await directory.list())) {
    if (bot.instructions === undefined) await directory.setInstructions(bot.id, defaultInstructions(team, bot, korean), 'default');
  }
}

/** The model writes each template-only member a prompt for this team's purpose (in the background; owner versions stay). */
export async function refineInstructions(llm: LlmGateway, directory: BotDirectory, team: BotTeam, korean: boolean): Promise<number> {
  let written = 0;
  for (const bot of membersOf(team, await directory.list())) {
    if (bot.instructionsBy === 'owner' || bot.instructionsBy === 'ai' || bot.status === 'off') continue;
    const text = await draftInstructions(llm, team, bot, korean);
    if (text === undefined) continue;
    // the owner may have written one while the model was thinking
    const now = (await directory.get(bot.id))?.instructionsBy;
    if (now === 'owner') continue;
    await directory.setInstructions(bot.id, text, 'ai');
    written += 1;
  }
  return written;
}

export async function setTeamTiers(directory: BotDirectory, teamId: string, tiers: Partial<TeamTiers>, control?: LlmControl): Promise<BotTeam | undefined> {
  const team = (await directory.teams()).find((item) => item.id === teamId);
  if (team === undefined) return undefined;
  const merged: TeamTiers = {
    lead: tiers.lead ?? team.tiers.lead,
    staff: tiers.staff ?? team.tiers.staff,
    ...(team.tiers.reviewer !== undefined || team.kind === 'dev' ? { reviewer: tiers.reviewer ?? team.tiers.reviewer ?? 'S' } : {}),
  };
  // the owner's own choice: the composition harness never touches this team again
  const next: BotTeam = { ...team, tiers: merged, decidedBy: 'owner' };
  await directory.upsertTeam(next);
  await applyTeamTiers(next, await directory.list(), control);
  return next;
}

/** Grows or shrinks a team to these counts (members beyond them are turned off, never deleted, so rooms keep history). */
export async function resizeTeam(directory: BotDirectory, teamId: string, staffCount: number, reviewerCount: number, korean: boolean, decidedBy: 'owner' | 'ai'): Promise<BotTeam | undefined> {
  const team = (await directory.teams()).find((item) => item.id === teamId);
  if (team === undefined) return undefined;
  const staffN = Math.max(1, Math.min(6, staffCount));
  const reviewN = Math.max(0, Math.min(3, reviewerCount));
  const t = texts(korean, team.name, team.purpose);
  const base = team.id.slice(5);
  const common = { group: team.group, origin: 'owner' as const, team: team.id };
  const bots = await directory.list();
  for (let n = 1; n <= 6; n += 1) {
    const id = `${base}-s${n}`.slice(0, 31);
    const existing = bots.find((bot) => bot.id === id);
    const status = existing === undefined || existing.status === 'off' ? 'idle' : existing.status;
    if (n <= staffN) await directory.upsert({ id, name: existing?.name ?? t.staff(n).name, role: existing?.role ?? t.staff(n).role, ...common, origin: existing?.origin ?? 'owner', kind: 'general', rank: 'staff', status });
    else if (existing !== undefined && existing.status !== 'off') await directory.setStatus(id, 'off');
  }
  for (let n = 1; n <= 3; n += 1) {
    const id = `${base}-review${n === 1 ? '' : String(n)}`.slice(0, 31);
    const existing = bots.find((bot) => bot.id === id);
    const fresh = n === 1 ? t.reviewer : { name: `${t.reviewer.name} ${n}`, role: t.reviewer.role };
    const status = existing === undefined || existing.status === 'off' ? 'idle' : existing.status;
    if (n <= reviewN) await directory.upsert({ id, name: existing?.name ?? fresh.name, role: existing?.role ?? fresh.role, ...common, origin: existing?.origin ?? 'owner', kind: team.kind, rank: 'reviewer', status });
    else if (existing !== undefined && existing.status !== 'off') await directory.setStatus(id, 'off');
  }
  const tiers: TeamTiers = { lead: team.tiers.lead, staff: team.tiers.staff, ...(reviewN > 0 ? { reviewer: team.tiers.reviewer ?? DEFAULT_TIERS.reviewer ?? 'S' } : {}) };
  const next: BotTeam = { ...team, staffCount: staffN, reviewerCount: reviewN, tiers, decidedBy };
  await directory.upsertTeam(next);
  await giveDefaultInstructions(directory, next, korean);
  return next;
}
