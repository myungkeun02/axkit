import type { BacklogSnapshot } from '../../core/contracts/index.js';
import type { CloseReason, CompanyTask, TaskStatus } from './types.js';

/** Words for accepting, refusing and acknowledging requests. */
export interface IntakeTexts {
  readonly language: 'ko' | 'en';
  readonly unknownTask: string;
  companyFull(maxOpen: number): string;
  teamFull(teamName: string, maxOpenPerTeam: number): string;
  unknownTeam(teamNames: readonly string[]): string;
  duplicate(title: string): string;
  accepted(task: CompanyTask): string;
  dropped(title: string): string;
}

/** Words for the daily report and the backlog health line. */
export interface ReportTexts {
  readonly language: 'ko' | 'en';
  title(ymd: string, counts: { done: number; failed: number; closed: number; open: number }): string;
  statusLabel(status: TaskStatus): string;
  closeReasonLabel(reason: CloseReason): string;
  acceptLabel(title: string): string;
  dropLabel(title: string): string;
  backlogLine(snapshot: BacklogSnapshot): string;
}

const KO_STATUS: Record<TaskStatus, string> = {
  awaiting_accept: '대기 확인',
  queued: '대기',
  planning: '계획 중',
  running: '진행 중',
  review: '검토 중',
  awaiting_owner: '결재 대기',
  done: '완료',
  failed: '실패',
  closed: '닫힘',
};

const EN_STATUS: Record<TaskStatus, string> = {
  awaiting_accept: 'Needs a yes',
  queued: 'Queued',
  planning: 'Planning',
  running: 'Running',
  review: 'In review',
  awaiting_owner: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
  closed: 'Closed',
};

const KO_REASON: Record<CloseReason, string> = {
  stale: '오래 멈춤',
  owner_wait_expired: '결재 기한 지남',
  declined: '거절',
  review_failed: '검토 통과 못 함',
  failed: '실패',
  cancelled: '취소',
};

const EN_REASON: Record<CloseReason, string> = {
  stale: 'Stalled',
  owner_wait_expired: 'Approval expired',
  declined: 'Declined',
  review_failed: 'Review failed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const KO_INTAKE: IntakeTexts = {
  language: 'ko',
  unknownTask: '그 일을 찾지 못했어요. 이미 처리됐을 수 있어요.',
  companyFull: (maxOpen) =>
    `지금 회사 일이 ${maxOpen}건 열려 있어 더 받지 않을게요. 끝나거나 닫히면 다시 맡겨 주세요.`,
  teamFull: (teamName, maxOpenPerTeam) => `${teamName} 팀은 이미 ${maxOpenPerTeam}건을 하고 있어요.`,
  unknownTeam: (teamNames) =>
    teamNames.length === 0
      ? '아직 회사 팀이 없어요. 설정에서 팀을 먼저 만들어 주세요.'
      : `어느 팀 일인지 모르겠어요. 팀: ${teamNames.join(', ')} — '@dev 할 일'처럼 적어 주세요.`,
  duplicate: (title) => `이미 맡긴 일이에요: ${title}`,
  accepted: (task) => `맡겼어요 — ${task.title}`,
  dropped: (title) => `닫을게요: ${title}`,
};

const EN_INTAKE: IntakeTexts = {
  language: 'en',
  unknownTask: 'I could not find that item. It may already be handled.',
  companyFull: (maxOpen) =>
    `${maxOpen} company tasks are open, so I will not take more. Ask again when some finish or close.`,
  teamFull: (teamName, maxOpenPerTeam) => `The ${teamName} team is already on ${maxOpenPerTeam} items.`,
  unknownTeam: (teamNames) =>
    teamNames.length === 0
      ? 'There are no company teams yet. Set them up first.'
      : `I cannot tell which team this is for. Teams: ${teamNames.join(', ')} — write it like '@dev do this'.`,
  duplicate: (title) => `That is already on the list: ${title}`,
  accepted: (task) => `Taken: ${task.title}`,
  dropped: (title) => `Closed: ${title}`,
};

const KO_REPORT: ReportTexts = {
  language: 'ko',
  title: (ymd, counts) =>
    `회사 일 ${ymd} — 완료 ${counts.done} · 실패 ${counts.failed} · 닫힘 ${counts.closed} · 열림 ${counts.open}`,
  statusLabel: (status) => KO_STATUS[status],
  closeReasonLabel: (reason) => KO_REASON[reason],
  acceptLabel: (title) => `받기 ${title}`,
  dropLabel: (title) => `거절 ${title}`,
  backlogLine: (snapshot) =>
    `회사 일: 열린 일 ${snapshot.open}/${snapshot.openLimit} · 오래 멈춤 ${snapshot.stale} · ` +
    `이번 주 만든 ${snapshot.createdInWeek} 낸 ${snapshot.doneInWeek} (자동 닫힘 ${snapshot.autoClosedInWeek})`,
};

const EN_REPORT: ReportTexts = {
  language: 'en',
  title: (ymd, counts) =>
    `Company work ${ymd} — done ${counts.done} · failed ${counts.failed} · closed ${counts.closed} · open ${counts.open}`,
  statusLabel: (status) => EN_STATUS[status],
  closeReasonLabel: (reason) => EN_REASON[reason],
  acceptLabel: (title) => `Accept ${title}`,
  dropLabel: (title) => `Decline ${title}`,
  backlogLine: (snapshot) =>
    `Company work: open ${snapshot.open}/${snapshot.openLimit} · stalled ${snapshot.stale} · ` +
    `made ${snapshot.createdInWeek}, shipped ${snapshot.doneInWeek} this week (auto-closed ${snapshot.autoClosedInWeek})`,
};

export function intakeTexts(language: string): IntakeTexts {
  return language === 'en' ? EN_INTAKE : KO_INTAKE;
}

export function reportTexts(language: string): ReportTexts {
  return language === 'en' ? EN_REPORT : KO_REPORT;
}
