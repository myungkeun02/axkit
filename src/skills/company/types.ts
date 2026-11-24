import type { Effect } from '../../core/policy/types.js';
import type { ApprovalRecord } from '../../core/policy/approval.js';
import type { Sensitivity, Tier } from '../../core/llm/types.js';

/** awaiting_accept: came from mail or another plugin; it is data until the owner accepts it. */
export type TaskStatus =
  | 'awaiting_accept'
  | 'queued'
  | 'planning'
  | 'running'
  | 'review'
  | 'awaiting_owner'
  | 'done'
  | 'failed'
  | 'closed';

export const OPEN_STATUSES: readonly TaskStatus[] = [
  'awaiting_accept',
  'queued',
  'planning',
  'running',
  'review',
  'awaiting_owner',
];

export type TaskSource = 'owner' | 'mail' | 'event';

export type CloseReason = 'stale' | 'owner_wait_expired' | 'declined' | 'review_failed' | 'failed' | 'cancelled';

export interface TaskStep {
  text: string;
  output?: string;
}

export interface CompanyTask {
  /** 8 hex characters. */
  id: string;
  team: string;
  title: string;
  /** The request as received, clipped. Mail and event requests are data, never instructions. */
  request: string;
  source: TaskSource;
  sourceRef?: string;
  status: TaskStatus;
  steps: TaskStep[];
  /** send / pay / delete the plan needs; only the owner can approve these, through a confirmation card. */
  ownerEffects: Effect[];
  result?: string;
  reviewNote?: string;
  revisions: number;
  approvals: ApprovalRecord[];
  /** Dev team: the dev-assist job id once dev.start ran. */
  devJobId?: string;
  closedReason?: CloseReason;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /** ISO 8601 when it reached done/failed/closed. */
  finishedAt?: string;
}

export interface RoleConfig {
  tier: Tier;
}

export interface TeamConfig {
  /** "dev", "marketing". */
  id: string;
  name: string;
  /** One line: what this team is for. */
  role: string;
  /** Words and topics this team answers for; the lead's classifier and the keyword fallback use them. */
  scope: readonly string[];
  lead: RoleConfig;
  member: RoleConfig;
  /** Highest sensitivity this team's model calls may carry. */
  sensitivity: Sensitivity;
  /** "dev" teams work through dev-assist (draft pull request at most); others write text deliverables. */
  kind: 'general' | 'dev';
  /** Dev teams: the dev-assist repository slug. */
  repo?: string;
  /** Discord channel id for the team's batched posts; omitted = the owner's DM digest. */
  channel?: string;
}

export interface CompanyLimits {
  /** Open tasks across all teams; intake refuses beyond it. */
  maxOpen: number;
  maxOpenPerTeam: number;
  /** An open task not touched for this long is closed with one line in the report. */
  maxAgeHours: number;
  /** Waiting for the owner longer than this closes the task. */
  ownerWaitDays: number;
  /** Review rounds before a task fails. */
  maxRevisions: number;
  /** Steps a plan may have. */
  maxSteps: number;
}

export interface CompanyConfig {
  teams: readonly TeamConfig[];
  limits: CompanyLimits;
  /** Company mode's own daily model budget; it never eats the assistant's budget. */
  dailyUsd: number;
  /** HH:MM: the one daily company report. */
  reportAt: string;
  /** Chat prefix that hands a request to the company ("회사"). */
  prefix: string;
  mailIntake: { enabled: boolean; query: string; everyMinutes: number };
}

/** Persisted tasks; one writer (the plugin), so read-modify-write is safe. */
export interface TaskRepository {
  all(): Promise<CompanyTask[]>;
  get(id: string): Promise<CompanyTask | undefined>;
  open(): Promise<CompanyTask[]>;
  create(input: Pick<CompanyTask, 'team' | 'title' | 'request' | 'source' | 'status'> & { sourceRef?: string }): Promise<CompanyTask>;
  /** Applies `change` and bumps updatedAt; sets finishedAt when the status becomes final. */
  update(id: string, change: (task: CompanyTask) => CompanyTask): Promise<CompanyTask | undefined>;
}

export const FINAL_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'closed'];

export function isOpen(task: CompanyTask): boolean {
  return OPEN_STATUSES.includes(task.status);
}
