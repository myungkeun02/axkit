import type { Effect } from '../../core/policy/types.js';

/** Which app the owner shared from; a missing value reads as the phone. */
export type ShareOrigin = 'phone' | 'desktop';

export interface AppTexts {
  effectLabels: Record<Effect, string>;
  editPrompt: string;
  approveOption: string;
  denyOption: string;
  approveDetail: string;
  denyDetail: string;
  cardReply(summary: string, text: string): string;
  sharedFile(name: string, kind: 'image' | 'audio' | 'file', from?: ShareOrigin): string;
  sharedText(text: string, from?: ShareOrigin): string;
  push: {
    cardTitle: string;
    noticeTitle(assistant: string): string;
    hidden: string;
    picture: string;
    approve: string;
    deny: string;
    testBody: string;
  };
}

const KO: AppTexts = {
  effectLabels: { read: '읽기', write: '변경', send: '보내기', pay: '결제', delete: '삭제', system: '맥에서 명령 실행' },
  editPrompt: '무엇을 고칠까요? 바꿀 내용을 말씀해 주세요.',
  approveOption: '네, 해 주세요',
  denyOption: '하지 마세요',
  approveDetail: '적힌 그대로 지금 해요',
  denyDetail: '아무것도 하지 않고 끝내요',
  cardReply: (summary, text) => `[확인 카드 답: "${summary}" 대신] ${text}`,
  sharedFile: (name, kind, from) =>
    `(${from === 'desktop' ? '데스크톱' : '휴대폰'}에서 ${kind === 'image' ? '사진' : kind === 'audio' ? '음성 파일' : '파일'}을 공유했어요: ${name})`,
  sharedText: (text, from) => `(${from === 'desktop' ? '데스크톱' : '휴대폰'}에서 공유)\n${text}`,
  push: {
    cardTitle: '확인이 필요해요',
    noticeTitle: (assistant) => `${assistant} 알림`,
    hidden: '새 알림이 있어요',
    picture: '사진을 보냈어요',
    approve: '승인',
    deny: '거절',
    testBody: '푸시 알림이 잘 와요',
  },
};

const EN: AppTexts = {
  effectLabels: { read: 'Read', write: 'Change', send: 'Send', pay: 'Pay', delete: 'Delete', system: 'Run on this Mac' },
  editPrompt: 'What should I change? Tell me what to fix.',
  approveOption: 'Yes, go ahead',
  denyOption: "Don't",
  approveDetail: 'Does exactly what it says, now',
  denyDetail: 'Nothing happens',
  cardReply: (summary, text) => `[Reply to the card "${summary}" instead] ${text}`,
  sharedFile: (name, kind, from) =>
    `(Shared from the ${from === 'desktop' ? 'desktop' : 'phone'}: ${kind === 'image' ? 'photo' : kind === 'audio' ? 'audio' : 'file'} ${name})`,
  sharedText: (text, from) => `(Shared from the ${from === 'desktop' ? 'desktop' : 'phone'})\n${text}`,
  push: {
    cardTitle: 'Needs your OK',
    noticeTitle: (assistant) => `${assistant} notice`,
    hidden: 'You have a new notification',
    picture: 'Sent a picture',
    approve: 'Approve',
    deny: 'Deny',
    testBody: 'Push notifications work',
  },
};

export function appTexts(language: string): AppTexts {
  return language === 'en' ? EN : KO;
}
