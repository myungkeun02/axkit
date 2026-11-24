/**
 * Names a person reads for the jobs ax-kit ships. A job's own `label` wins; an unknown job shows its id. Keyed by the
 * job name, so a renamed job simply falls back to its id.
 */
const LABELS: Record<string, { ko: string; en: string }> = {
  'core.retention': { ko: '오래된 기록 정리', en: 'Old record cleanup' },
  'core.failure-retention': { ko: '오래된 실패 기록 정리', en: 'Old failure cleanup' },
  'core.pause-expiry': { ko: '일시정지 만료 알림', en: 'Pause expiry notice' },
  'core.notify.digest': { ko: '모아 둔 알림 보내기', en: 'Held notice digest' },
  'mobile.maintenance': { ko: '휴대폰 연결 정리', en: 'Phone link maintenance' },
  'briefing.morning': { ko: '아침 브리핑', en: 'Morning briefing' },
  'briefing.now': { ko: '브리핑 다시 보내기', en: 'Briefing retry' },
  'interview.daily': { ko: '하루 질문', en: 'Daily question' },
  'onboarding.daily': { ko: '처음 설정 안내', en: 'Onboarding tips' },
  'knowledge.rebuild': { ko: '지식 문서 다시 만들기', en: 'Knowledge rebuild' },
  'docs.mirror': { ko: '문서 파일로 내보내기', en: 'Docs mirror' },
  'memory.expiry': { ko: '기억 만료 확인', en: 'Memory expiry' },
  'memory.checkin': { ko: '기억 확인 질문', en: 'Memory check-in' },
  'memory.people.mail': { ko: '메일에서 사람 정보 모으기', en: 'People from mail' },
  'memory.people.calendar': { ko: '일정에서 사람 정보 모으기', en: 'People from calendar' },
  'todo.reminders': { ko: '할 일 알림', en: 'To-do reminders' },
  'todo.sync': { ko: '할 일 ↔ 미리 알림 동기화', en: 'To-do ↔ Reminders sync' },
  'day.prep': { ko: '일정 준비 알림', en: 'Meeting prep' },
  'day.travel': { ko: '이동 시간 알림', en: 'Travel time' },
  'day.close': { ko: '하루 마무리', en: 'Day close' },
  'day.health': { ko: '건강 알림', en: 'Health nudge' },
  'day.health.snooze': { ko: '건강 알림 다시 알림', en: 'Health nudge snooze' },
  'day.replies': { ko: '밀린 메일 답장 알림', en: 'Mail replies' },
  'chat-inbox.replies': { ko: '밀린 채팅 답장 알림', en: 'Chat replies' },
  'chat-inbox.appointments': { ko: '채팅 속 약속 찾기', en: 'Chat appointments' },
  'kakao-desktop.poll': { ko: '카카오톡 화면 읽기', en: 'KakaoTalk reader' },
  'discord-app.poll': { ko: '디스코드 화면 읽기', en: 'Discord reader' },
  'spending.mail': { ko: '메일 영수증 읽기', en: 'Mail receipts' },
  'spending.labels': { ko: '지출 분류', en: 'Spending labels' },
  'spending.report': { ko: '지출 보고', en: 'Spending report' },
  'spending.monthend': { ko: '월말 지출 정리', en: 'Month-end spending' },
  'spending.subscriptions': { ko: '구독 갱신 알림', en: 'Subscription renewals' },
  'expenses.monthly': { ko: '월 경비 청구 정리', en: 'Monthly expenses' },
  'receipts.scan': { ko: '영수증 찾기', en: 'Receipt scan' },
  'receipts.monthend': { ko: '월말 영수증 정리', en: 'Month-end receipts' },
  'trip.scan': { ko: '여행 일정 찾기', en: 'Trip scan' },
  'trip.checklist': { ko: '여행 준비물 알림', en: 'Trip checklist' },
  'files.index': { ko: '파일 목록 갱신', en: 'File index' },
  'watch.sweep': { ko: '지켜보기 확인', en: 'Watch sweep' },
  'tuning.weekly': { ko: '주간 개선 점검', en: 'Weekly tuning' },
  'company.tick': { ko: '팀 일 진행', en: 'Team work' },
  'company.report': { ko: '팀 보고', en: 'Team report' },
  'company.mail-intake': { ko: '팀 메일 받기', en: 'Team mail intake' },
};

export function jobLabel(name: string, language: string): string | undefined {
  const entry = LABELS[name];
  if (entry === undefined) return undefined;
  return language === 'en' ? entry.en : entry.ko;
}
