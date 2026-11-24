import type { BotTeam } from '../contracts/bots.js';
import type { KeyValueStore } from '../store/types.js';

/**
 * R16 운영 중 조정: how a team's recent runs went. When work keeps piling up (the lead wants more hands, or requests
 * arrive while the team is still busy) or staff tasks fail often, the team is offered one resize on a card
 * (R15 topic `team:resize:<id>`, so it is asked once). Teams the owner sized are never proposed for.
 */
export interface TeamRun {
  at: string;
  tasks: number;
  failed: number;
  wantedMore: boolean;
  /** A request came in while this team was still working on another. */
  overlapped: boolean;
}

export interface ResizeProposal {
  staffCount: number;
  reviewerCount: number;
  why: string;
}

const KEEP = 30;
const WINDOW_MS = 7 * 86_400_000;
const MIN_RUNS = 5;

export class TeamHealth {
  constructor(private readonly kv: KeyValueStore) {}

  async record(teamId: string, run: TeamRun): Promise<TeamRun[]> {
    const runs = [run, ...((await this.kv.get<TeamRun[]>(`team.runs.${teamId}`)) ?? [])].slice(0, KEEP);
    await this.kv.set(`team.runs.${teamId}`, runs);
    return runs;
  }

  async runs(teamId: string): Promise<TeamRun[]> {
    return (await this.kv.get<TeamRun[]>(`team.runs.${teamId}`)) ?? [];
  }
}

/** The rule: at least five runs this week; crowded → one more staff; failing → one more reviewer (within limits). */
export function resizeFor(team: BotTeam, runs: readonly TeamRun[], now: Date, korean: boolean): ResizeProposal | undefined {
  if (team.decidedBy === 'owner') return undefined;
  const recent = runs.filter((run) => now.getTime() - Date.parse(run.at) <= WINDOW_MS);
  if (recent.length < MIN_RUNS) return undefined;
  const staff = team.staffCount ?? 3;
  const reviewers = team.reviewerCount ?? (team.kind === 'dev' ? 1 : 0);
  const crowded = recent.filter((run) => run.wantedMore || run.overlapped).length;
  const tasks = recent.reduce((sum, run) => sum + run.tasks, 0);
  const failed = recent.reduce((sum, run) => sum + run.failed, 0);
  if (crowded >= Math.ceil(recent.length / 2) && staff < 6) {
    return { staffCount: staff + 1, reviewerCount: reviewers, why: korean ? `이번 주 ${recent.length}번 중 ${crowded}번 일이 밀렸어요` : `work piled up in ${crowded} of ${recent.length} runs` };
  }
  if (tasks >= 5 && failed / tasks >= 0.3 && reviewers < 3) {
    return { staffCount: staff, reviewerCount: reviewers + 1, why: korean ? `맡긴 일 ${tasks}건 중 ${failed}건을 끝내지 못했어요` : `${failed} of ${tasks} tasks failed` };
  }
  return undefined;
}
