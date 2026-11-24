import type { ConfirmTexts } from './confirm.js';

const KO: ConfirmTexts = {
  approve: '승인',
  deny: '거절',
  effectsLabel: '영향:',
  noteLabel: '확인이 필요한 이유:',
  effectLabels: { read: '읽기', write: '변경', send: '보내기', pay: '결제', delete: '삭제', system: '맥에서 명령 실행' },
  approvedNote: '승인했어요.',
  deniedNote: '거절했어요.',
  expiredNote: '시간이 지나 취소됐어요.',
  closedNote: '다른 곳(휴대폰 앱)에서 처리했어요.',
};

const EN: ConfirmTexts = {
  approve: 'Approve',
  deny: 'Deny',
  effectsLabel: 'Effects:',
  noteLabel: 'Why I am asking:',
  effectLabels: { read: 'Read', write: 'Change', send: 'Send', pay: 'Pay', delete: 'Delete', system: 'Run on this Mac' },
  approvedNote: 'Approved.',
  deniedNote: 'Denied.',
  expiredNote: 'Expired.',
  closedNote: 'Answered elsewhere (phone app).',
};

export function confirmTexts(language: string): ConfirmTexts {
  return language === 'en' ? EN : KO;
}
