import type { SpendCategory, TuningChange } from '../../core/contracts/index.js';
import { SPEND_CATEGORIES } from '../../core/contracts/index.js';
import type { MeasuredEffect, ProposalReason } from './types.js';
import { isSpendCategory } from './types.js';

export type TuningLanguage = 'ko' | 'en';

export interface TuningTexts {
  readonly language: TuningLanguage;
  readonly apply: string;
  readonly skip: string;
  readonly weeklyTitle: string;
  readonly measuredHeading: string;
  readonly proposalHeading: string;
  readonly listTitle: string;
  readonly listEmpty: string;
  readonly unknownProposal: string;
  readonly undoNotFound: string;
  readonly undoAlready: string;
  readonly checkHeading: string;
  readonly recordTitle: string;
  readonly recordBody: string;
  category(category: SpendCategory): string;
  proposalReason(reason: ProposalReason, subject: string): string;
  proposalLine(index: number, reason: string): string;
  changeLabel(change: TuningChange): string;
  measuredLine(change: TuningChange, before: number, after: number): string;
  appliedReply(change: TuningChange): string;
  declinedReply(change: TuningChange): string;
  undoDescription(id: string): string;
  undoDone(change: TuningChange): string;
  openLine(id: string, reason: string): string;
  modelLine(purpose: string, failures: number, calls: number): string;
  expiredFactsLine(count: number): string;
  recordProposed(reason: string): string;
  recordApplied(change: TuningChange): string;
  recordDeclined(change: TuningChange): string;
  recordMeasured(change: TuningChange, baseline: number, after: number, effective: boolean): string;
  recordReverted(change: TuningChange): string;
  appliedLine(
    id: string,
    change: TuningChange,
    baselinePerWeek: number,
    measured: MeasuredEffect | undefined,
    undone: boolean,
  ): string;
}

type CategoryLabels = Record<SpendCategory, string>;

function labels(values: CategoryLabels): CategoryLabels {
  for (const category of SPEND_CATEGORIES) {
    if (values[category] === '') throw new Error(`missing category label: ${category}`);
  }
  return values;
}

const KO_LABELS = labels({
  food: '식비',
  cafe: '카페',
  groceries: '장보기',
  transport: '교통',
  shopping: '쇼핑',
  living: '생활·공과금',
  health: '의료',
  culture: '문화',
  travel: '여행',
  education: '교육',
  subscription: '구독',
  ai: 'AI 서비스',
  infra: '인프라',
  transfer: '이체',
  other: '기타',
});

const EN_LABELS = labels({
  food: 'Food',
  cafe: 'Cafe',
  groceries: 'Groceries',
  transport: 'Transport',
  shopping: 'Shopping',
  living: 'Living',
  health: 'Health',
  culture: 'Culture',
  travel: 'Travel',
  education: 'Education',
  subscription: 'Subscription',
  ai: 'AI services',
  infra: 'Infrastructure',
  transfer: 'Transfer',
  other: 'Other',
});

const formatCount = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

function categoryOf(map: CategoryLabels, value: string | undefined): string | undefined {
  return value !== undefined && isSpendCategory(value) ? map[value] : undefined;
}

function koChangeLabel(change: TuningChange): string {
  if (change.domain === 'notice') {
    return change.action === 'unmute' ? `알림 '${change.subject}' 다시 켜기` : `알림 '${change.subject}' 끄기`;
  }
  if (change.domain === 'chat.appointment') {
    return change.action === 'unmute'
      ? `'${change.subject}' 방 일정 제안 다시 켜기`
      : `'${change.subject}' 방 일정 제안 끄기`;
  }
  if (change.domain === 'spend.category') {
    if (change.action === 'set') {
      const category = categoryOf(KO_LABELS, change.value);
      return category === undefined ? `'${change.subject}' 규칙 추가` : `'${change.subject}' → ${category}`;
    }
    return `'${change.subject}' 규칙 지우기`;
  }
  if (change.domain === 'feature') {
    return change.action === 'unmute' ? `'${change.subject}' 기능 다시 켜기` : `'${change.subject}' 기능 7일 멈추기`;
  }
  if (change.domain === 'company.limits') {
    return change.action === 'set'
      ? `회사 일 동시에 여는 개수 ${change.value ?? ''}건으로`
      : '회사 일 동시에 여는 개수 제한 풀기';
  }
  return `${change.domain} '${change.subject}' ${change.action}`;
}

function enChangeLabel(change: TuningChange): string {
  if (change.domain === 'notice') {
    return change.action === 'unmute'
      ? `turn the '${change.subject}' notice back on`
      : `turn off the '${change.subject}' notice`;
  }
  if (change.domain === 'chat.appointment') {
    return change.action === 'unmute'
      ? `turn appointments back on for '${change.subject}'`
      : `stop appointments for '${change.subject}'`;
  }
  if (change.domain === 'spend.category') {
    if (change.action === 'set') {
      const category = categoryOf(EN_LABELS, change.value);
      return category === undefined ? `add the '${change.subject}' rule` : `'${change.subject}' → ${category}`;
    }
    return `remove the '${change.subject}' rule`;
  }
  if (change.domain === 'feature') {
    return change.action === 'unmute'
      ? `turn the '${change.subject}' feature back on`
      : `pause the '${change.subject}' feature for 7 days`;
  }
  if (change.domain === 'company.limits') {
    return change.action === 'set'
      ? `open ${change.value ?? ''} company tasks at once`
      : 'remove the company open-task limit';
  }
  return `${change.domain} '${change.subject}' ${change.action}`;
}

const KO: TuningTexts = {
  language: 'ko',
  apply: '적용',
  skip: '그대로',
  weeklyTitle: '이번 주 조정 제안',
  measuredHeading: '지난 제안의 효과',
  proposalHeading: '새 제안',
  listTitle: '조정 제안과 적용 기록',
  listEmpty: '아직 조정할 것이 없어요.',
  unknownProposal: '이 제안은 이미 처리됐거나 찾을 수 없어요.',
  undoNotFound: '되돌릴 적용 기록을 찾지 못했어요.',
  undoAlready: '이미 되돌린 변경이에요.',
  checkHeading: '점검',
  recordTitle: '개선 기록',
  recordBody: '주간 조정 제안과 적용·측정·되돌림 기록이에요.',
  category: (category) => KO_LABELS[category],
  proposalReason: (reason, subject) => {
    if (reason.kind === 'notice') {
      return `알림 '${subject}' 거절이 ${reason.rejections}번 있었어요 → 이 알림은 끌까요?`;
    }
    if (reason.kind === 'room') {
      return `'${subject}' 방의 일정 제안을 ${reason.rejections}번 거절하셨어요 → 이 방은 일정 제안을 그만할까요?`;
    }
    if (reason.kind === 'notice_volume') {
      return `'${reason.noticeKind}' 알림이 이번 주 ${reason.perWeek}건 갔는데 한 번도 누르지 않으셨어요 → 끄기`;
    }
    if (reason.kind === 'feature_failures') {
      return `'${reason.feature}' 기능이 이번 주 같은 이유(${reason.signature})로 ${reason.perWeek}번 실패했어요 → 7일 멈춤`;
    }
    if (reason.kind === 'backlog') {
      const value = Math.max(1, reason.limit - 2);
      return (
        `회사 일 ${reason.created}건 받고 ${reason.done}건 끝냈고 ${reason.autoClosed}건은 오래 멈춰 닫혔어요 ` +
        `→ 동시에 여는 일 ${reason.limit} → ${value}건`
      );
    }
    if (reason.kind === 'no_effect') {
      return (
        `지난주 적용한 '${subject}' 조정이 효과가 없었어요` +
        `(주 ${formatCount(reason.baseline)} → ${formatCount(reason.after)}) → 되돌리기`
      );
    }
    const category = KO_LABELS[reason.category];
    return (
      `'${reason.token}' 포함 가맹점 ${reason.count}곳을 ${category}로 고치셨어요 ` +
      `→ 앞으로 이 단어가 들어간 지출은 ${category}로 둘까요?`
    );
  },
  proposalLine: (index, reason) => `${index}. ${reason}`,
  changeLabel: koChangeLabel,
  measuredLine: (change, before, after) =>
    `${koChangeLabel(change)}: 주 ${formatCount(before)}회 → 주 ${formatCount(after)}회`,
  appliedReply: (change) => `적용했어요 — ${koChangeLabel(change)}`,
  declinedReply: (change) => `그대로 둘게요 — ${koChangeLabel(change)}`,
  undoDescription: (id) => `조정 되돌리기: #${id}`,
  undoDone: (change) => `되돌렸어요 — ${koChangeLabel(change)}`,
  openLine: (id, reason) => `#${id} ${reason}`,
  modelLine: (purpose, failures, calls) => `'${purpose}' 모델 호출 ${calls}번 중 ${failures}번 실패`,
  expiredFactsLine: (count) => `끝 조건이 지난 사실 ${count}개를 다시 확인해 주세요`,
  recordProposed: (reason) => `제안: ${reason}`,
  recordApplied: (change) => `적용: ${koChangeLabel(change)}`,
  recordDeclined: (change) => `그대로 둠: ${koChangeLabel(change)}`,
  recordMeasured: (change, baseline, after, effective) =>
    `측정: ${koChangeLabel(change)} 주 ${formatCount(baseline)} → 주 ${formatCount(after)} · 효과 ${effective ? '있음' : '없음'}`,
  recordReverted: (change) => `되돌림: ${koChangeLabel(change)}`,
  appliedLine: (id, change, baseline, measured, undone) => {
    const effect = measured === undefined ? '' : ` → 주 ${formatCount(measured.afterPerWeek)}회`;
    const tail = undone ? ' (되돌림)' : '';
    return `#${id} ${koChangeLabel(change)} · 기준 주 ${formatCount(baseline)}회${effect}${tail}`;
  },
};

const EN: TuningTexts = {
  language: 'en',
  apply: 'Apply',
  skip: 'Keep as is',
  weeklyTitle: "This week's tuning suggestions",
  measuredHeading: 'Effect of earlier changes',
  proposalHeading: 'New suggestions',
  listTitle: 'Tuning proposals and applied changes',
  listEmpty: 'Nothing to tune yet.',
  unknownProposal: 'That proposal was already handled or cannot be found.',
  undoNotFound: 'No applied change matches that id.',
  undoAlready: 'That change was already undone.',
  checkHeading: 'Checks',
  recordTitle: 'Improvement log',
  recordBody: 'Weekly tuning proposals and what happened to each one.',
  category: (category) => EN_LABELS[category],
  proposalReason: (reason, subject) => {
    if (reason.kind === 'notice') {
      return `You rejected the '${subject}' notice ${reason.rejections} times → turn this notice off?`;
    }
    if (reason.kind === 'room') {
      return (
        `You rejected appointment suggestions from '${subject}' ${reason.rejections} times ` +
        '→ stop suggesting appointments for this room?'
      );
    }
    if (reason.kind === 'notice_volume') {
      return (
        `The '${reason.noticeKind}' notice went out ${reason.perWeek} times this week ` +
        'and you never tapped it → turn it off'
      );
    }
    if (reason.kind === 'feature_failures') {
      return (
        `'${reason.feature}' failed ${reason.perWeek} times this week for the same reason ` +
        `(${reason.signature}) → pause it for 7 days`
      );
    }
    if (reason.kind === 'backlog') {
      const value = Math.max(1, reason.limit - 2);
      return (
        `You took ${reason.created} company tasks, finished ${reason.done}, and ${reason.autoClosed} were ` +
        `closed after sitting too long → open at once ${reason.limit} → ${value}`
      );
    }
    if (reason.kind === 'no_effect') {
      return (
        `Last week's change to '${subject}' had no effect ` +
        `(${formatCount(reason.baseline)}/week → ${formatCount(reason.after)}) → undo it`
      );
    }
    const category = EN_LABELS[reason.category];
    return (
      `You changed ${reason.count} merchants containing '${reason.token}' to ${category} ` +
      `→ treat spend with this word as ${category} from now on?`
    );
  },
  proposalLine: (index, reason) => `${index}. ${reason}`,
  changeLabel: enChangeLabel,
  measuredLine: (change, before, after) =>
    `${enChangeLabel(change)}: ${formatCount(before)}/week → ${formatCount(after)}/week`,
  appliedReply: (change) => `Applied: ${enChangeLabel(change)}`,
  declinedReply: (change) => `Kept as is: ${enChangeLabel(change)}`,
  undoDescription: (id) => `Undo tuning change: #${id}`,
  undoDone: (change) => `Undone: ${enChangeLabel(change)}`,
  openLine: (id, reason) => `#${id} ${reason}`,
  modelLine: (purpose, failures, calls) => `'${purpose}' model failed ${failures} of ${calls} calls`,
  expiredFactsLine: (count) => `${count} facts have passed their end condition; please confirm them again`,
  recordProposed: (reason) => `Proposed: ${reason}`,
  recordApplied: (change) => `Applied: ${enChangeLabel(change)}`,
  recordDeclined: (change) => `Kept as is: ${enChangeLabel(change)}`,
  recordMeasured: (change, baseline, after, effective) => `Measured: ${enChangeLabel(change)} ${formatCount(baseline)}/week → ${formatCount(after)}/week · ${effective ? 'effective' : 'no effect'}`,
  recordReverted: (change) => `Reverted: ${enChangeLabel(change)}`,
  appliedLine: (id, change, baseline, measured, undone) => {
    const effect = measured === undefined ? '' : ` → ${formatCount(measured.afterPerWeek)}/week`;
    const tail = undone ? ' (undone)' : '';
    return `#${id} ${enChangeLabel(change)} · baseline ${formatCount(baseline)}/week${effect}${tail}`;
  },
};

export function tuningTexts(language: string): TuningTexts {
  return language === 'en' ? EN : KO;
}
