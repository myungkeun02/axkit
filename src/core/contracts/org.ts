/**
 * The owner's organisations as the first look found them in documents, mail and calendar: departments and teams
 * with their leads and members, and the recurring work worth a routine. Nothing here is built until the owner says so.
 */

/** One department or team inside an organisation ("에이컴퍼니 / 마케팅본부 / 브랜드팀"). */
export interface OrgUnit {
  /** The company or organisation. */
  org: string;
  name: string;
  /** The unit it sits under, by name, inside the same organisation. */
  parent?: string;
  /** What the unit does, one sentence. */
  purpose?: string;
  /** The lead's name, one of `members`. */
  lead?: string;
  /** People's names as the documents write them. */
  members: readonly string[];
  /** Human-readable citations ("Drive: 2026 조직도", "~/Documents/인사/명부.xlsx", "mail signatures"). */
  sources: readonly string[];
  /** Assistant helpers this unit's work needs; its proposed team's staff are made from these. */
  roles?: readonly { title: string; does: string }[];
  /** "dev" for a software unit: its team gets a reviewer. */
  kind?: 'dev' | 'general';
}

/** When a proposed routine runs, in the owner's time zone. `monthly.day` -1 is the last day of the month. */
export type ProposedSchedule =
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'; at: string }
  | { kind: 'monthly'; day: number; at: string }
  | { kind: 'every'; hours: number };

/** Recurring work found in the owner's calendar, mail and files, proposed as a routine with what shows it. */
export interface RoutineProposal {
  title: string;
  /** What the routine does each time: it prepares, drafts or reports, never sends, pays or deletes. */
  instruction: string;
  schedule: ProposedSchedule;
  /** The team (an org unit or a project) that should own it, by name; undefined for the main assistant. */
  team?: string;
  company?: string;
  /** Short lines a person can check: "캘린더 '주간 회의' 14번 · 매주 월 10:00". */
  evidence: readonly string[];
}
