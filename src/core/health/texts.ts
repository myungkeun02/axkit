import type { HealthTexts } from './builtin.js';

export const koHealthTexts: HealthTexts = {
  switchLongPaused: (feature, days, reason) => `${feature} 일시정지가 ${days}일째 켜져 있어요: ${reason}`,
  switchAutoPaused: (feature, reason) => `같은 실패가 반복돼 자동으로 멈췄어요: ${feature} (${reason})`,
  switchNone: () => '켜져 있는 일시정지가 없어요',
  noticeBudget: (days, maxOverBudgetDays) =>
    `이번 주 알림 예산을 넘긴 날이 ${days}일이에요 (허용 ${maxOverBudgetDays}일)`,
  noticeLoud: (kind, count) => `${kind} 알림이 이번 주에 ${count}번 왔어요`,
  knowledgeReview: (count) => `다시 확인할 문서가 ${count}개 있어요`,
  knowledgeStale: (count) => `오래 확인하지 않은 문서가 ${count}개 있어요`,
  notGitCheckout: () => '코드 저장소가 아니라서 확인하지 못했어요',
  codeCommitted: () => '실행 중인 코드에 저장 안 된 변경이 없어요',
  uncommittedChanges: (count) => `실행 중인 코드에 커밋 안 된 변경 ${count}개가 있어요`,
  uncommittedFix: () => '커밋하거나 릴리스 빌드에서 실행하세요',
};

export const enHealthTexts: HealthTexts = {
  switchLongPaused: (feature, days, reason) => `${feature} pause has been on for ${days} days: ${reason}`,
  switchAutoPaused: (feature, reason) => `Stopped automatically after repeated failures: ${feature} (${reason})`,
  switchNone: () => 'No pauses are on',
  noticeBudget: (days, maxOverBudgetDays) =>
    `The notice budget was exceeded on ${days} days this week (allowed ${maxOverBudgetDays})`,
  noticeLoud: (kind, count) => `${kind} notices arrived ${count} times this week`,
  knowledgeReview: (count) => `${count} documents need another look`,
  knowledgeStale: (count) => `${count} documents have not been checked in a long time`,
  notGitCheckout: () => 'not a git checkout',
  codeCommitted: () => 'the running code has no uncommitted changes',
  uncommittedChanges: (count) => `the running code has ${count} uncommitted changes`,
  uncommittedFix: () => 'commit the changes or run a release build',
};
