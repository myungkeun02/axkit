import type { PlannedTeam } from '../../core/bots/from-scan.js';
import type { OrgUnit, RoutineProposal } from '../../core/contracts/org.js';
import type { PlanTeam, PlannedRoutine, TeamPlan } from './team-plan.js';
import { MAX_PLAN_TEAMS, ScheduleSchema } from './team-plan.js';

const MAX_TEAM_ROUTINES = 5;
const MAX_OWN_ROUTINES = 20;

/**
 * One proposed team per real department or team. A parent unit (본부) with nobody of its own under it is shown
 * through its children; a unit of one person with sub-units is left out the same way.
 */
export function unitTeams(units: readonly OrgUnit[]): PlanTeam[] {
  const parents = new Set(units.map((unit) => unit.parent).filter((name): name is string => name !== undefined));
  return units
    .filter((unit) => !(parents.has(unit.name) && unit.members.length <= 1))
    .map((unit) => ({
      company: unit.org.slice(0, 80),
      name: unit.name.slice(0, 60),
      purpose: (unit.purpose ?? '').slice(0, 300),
      kind: unit.kind ?? 'general',
      roles: (unit.roles ?? []).slice(0, 6).map((role) => ({ title: role.title.slice(0, 20), does: role.does.slice(0, 120) })),
      tasks: [],
      routines: [],
      unit: {
        ...(unit.parent !== undefined ? { parent: unit.parent.slice(0, 60) } : {}),
        ...(unit.lead !== undefined ? { lead: unit.lead.slice(0, 60) } : {}),
        members: unit.members.slice(0, 200).map((member) => member.slice(0, 60)),
      },
    }));
}

/** The picked projects of the scan as plan teams. */
export function projectTeams(planned: readonly PlannedTeam[]): PlanTeam[] {
  return planned.map((team) => ({
    company: team.company.slice(0, 80),
    name: team.name.slice(0, 60),
    purpose: team.purpose.slice(0, 300),
    kind: team.kind,
    roles: team.roles.slice(0, 6).map((role) => ({ title: role.title.slice(0, 20), does: role.does.slice(0, 120) })),
    tasks: team.tasks.slice(0, 10).map((task) => task.slice(0, 80)),
    routines: [],
  }));
}

/** Units first (the organisation as it is), then projects with a name of their own, within the plan's limit. */
export function mergeTeams(units: readonly PlanTeam[], projects: readonly PlanTeam[]): PlanTeam[] {
  const names = new Set(units.map((team) => team.name));
  return [...units, ...projects.filter((team) => !names.has(team.name))].slice(0, MAX_PLAN_TEAMS);
}

function asPlanned(proposal: RoutineProposal): PlannedRoutine | undefined {
  const schedule = ScheduleSchema.safeParse(proposal.schedule);
  if (!schedule.success || proposal.title.trim() === '' || proposal.instruction.trim() === '') return undefined;
  return { title: proposal.title.slice(0, 60), instruction: proposal.instruction.slice(0, 1000), schedule: schedule.data, evidence: proposal.evidence.slice(0, 5).map((line) => line.slice(0, 200)) };
}

/**
 * Recurring work found with evidence goes to the team it belongs to (up to five each); the rest, and work that belongs
 * to no team, goes to the main assistant. Returns what is left for the assistant.
 */
export function placeRoutines(teams: PlanTeam[], proposals: readonly RoutineProposal[]): PlannedRoutine[] {
  const own: PlannedRoutine[] = [];
  for (const proposal of proposals) {
    const routine = asPlanned(proposal);
    if (routine === undefined) continue;
    const team = proposal.team === undefined ? undefined : (teams.find((item) => item.name === proposal.team && (proposal.company === undefined || item.company === proposal.company)) ?? teams.find((item) => item.name === proposal.team));
    if (team !== undefined && team.routines.length < MAX_TEAM_ROUTINES) team.routines.push(routine);
    else if (own.length < MAX_OWN_ROUTINES) own.push(routine);
  }
  return own;
}

/** A new scan that found nothing the owner has not already answered (same teams, same routines) asks nothing again. */
export function sameAsBefore(previous: TeamPlan, teams: readonly PlanTeam[], routines: readonly PlannedRoutine[]): boolean {
  const key = (team: { company: string; name: string }): string => `${team.company}\u0000${team.name}`;
  const known = new Set(previous.teams.map(key));
  const titles = new Set([...previous.teams.flatMap((team) => team.routines), ...previous.routines].map((routine) => routine.title));
  return teams.every((team) => known.has(key(team))) && [...teams.flatMap((team) => team.routines), ...routines].every((routine) => titles.has(routine.title));
}
