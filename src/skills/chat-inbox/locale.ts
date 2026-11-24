import type { ChatApp } from '../../core/contracts/index.js';
import type { InboxApp } from './store.js';

export type ChatInboxLanguage = 'ko' | 'en';

export interface ChatInboxTexts {
  readonly language: ChatInboxLanguage;
  appLabel(app: InboxApp): string;
  interactionSummary(app: ChatApp): string;
  appointmentNotice(app: InboxApp, room: string, quote: string): string;
  /** Room name for a text message whose sender the phone did not report. */
  readonly smsUnknownSender: string;
  readonly appointmentAdd: string;
  readonly appointmentNo: string;
  eventAdded(title: string): string;
  eventRejected(reason: string): string;
  eventFailed(reason: string): string;
  readonly eventDenied: string;
  readonly calendarMissing: string;
  readonly appointmentDismissed: string;
  readonly unknownChoice: string;
  readonly staleSuggestion: string;
  repliesTitle(count: number): string;
  replyLine(app: ChatApp, room: string, age: string, quote: string): string;
  repliedChoice(room: string): string;
  readonly muteRepliesLabel: string;
  repliedDone(room: string): string;
  readonly muteRepliesDone: string;
  readonly muteUnavailable: string;
  ago(hours: number, days: number): string;
}

/** "민수와 약속" / "민수 과 약속" depends on the last syllable, so pick the particle in code. */
function waGwa(name: string): string {
  const code = name.codePointAt(name.length - 1);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) return `${name}와`;
  return (code - 0xac00) % 28 === 0 ? `${name}와` : `${name}과`;
}

const KO_APP: Record<InboxApp, string> = { kakao: '카톡', discord: '디스코드', sms: '문자' };
const EN_APP: Record<InboxApp, string> = { kakao: 'KakaoTalk', discord: 'Discord', sms: 'Text message' };

const KO: ChatInboxTexts = {
  language: 'ko',
  appLabel: (app) => KO_APP[app],
  interactionSummary: (app) => (app === 'kakao' ? '카카오톡 대화' : '디스코드 대화'),
  appointmentNotice: (app, room, quote) =>
    app === 'sms'
      ? `문자 · ${room}: "${quote}" → 일정으로 넣을까요?`
      : `${KO_APP[app]} · ${room}: "${quote}" → 일정으로 넣을까요? (${waGwa(room)} 약속)`,
  smsUnknownSender: '보낸 사람 모름',
  appointmentAdd: '일정에 넣기',
  appointmentNo: '아니요',
  eventAdded: (title) => `일정에 넣었어요: ${title}`,
  eventRejected: (reason) => `일정에 넣지 못했어요: ${reason}`,
  eventFailed: (reason) => `일정을 넣다가 문제가 생겼어요: ${reason}`,
  eventDenied: '알겠어요. 일정에는 넣지 않았어요.',
  calendarMissing: '캘린더가 연결되어 있지 않아요.',
  appointmentDismissed: '알겠어요. 일정에 넣지 않을게요.',
  unknownChoice: '이미 처리했거나 오래된 버튼이에요.',
  staleSuggestion: '하루가 지나 "내일" 같은 말이 가리키는 날짜가 바뀌었어요. 날짜를 말씀해 주시면 넣어 드릴게요.',
  repliesTitle: (count) => `답장 안 한 대화 ${count}개`,
  replyLine: (app, room, age, quote) =>
    `- ${KO_APP[app]} · ${room} · ${age} · "${quote}"`,
  repliedChoice: (room) => `${room} 답했어요`,
  muteRepliesLabel: '이 알림 그만',
  repliedDone: (room) => `${room}에 답한 걸로 할게요.`,
  muteRepliesDone: '답장 알림은 더 보내지 않을게요.',
  muteUnavailable: '알림 설정을 찾지 못했어요.',
  ago: (hours, days) => (hours < 24 ? `${hours}시간 전` : `${days}일 전`),
};

const EN: ChatInboxTexts = {
  language: 'en',
  appLabel: (app) => EN_APP[app],
  interactionSummary: (app) => (app === 'kakao' ? 'KakaoTalk chat' : 'Discord chat'),
  appointmentNotice: (app, room, quote) =>
    app === 'sms'
      ? `Text message · ${room}: "${quote}" → Add this to your calendar?`
      : `${EN_APP[app]} · ${room}: "${quote}" → Add this to your calendar? (appointment with ${room})`,
  smsUnknownSender: 'Unknown sender',
  appointmentAdd: 'Add to calendar',
  appointmentNo: 'No thanks',
  eventAdded: (title) => `Added to your calendar: ${title}`,
  eventRejected: (reason) => `I did not add it: ${reason}`,
  eventFailed: (reason) => `Adding it failed: ${reason}`,
  eventDenied: 'Okay, I did not add it to your calendar.',
  calendarMissing: 'A calendar is not connected.',
  appointmentDismissed: 'Okay, I will not add it.',
  unknownChoice: 'That button was already handled or is too old.',
  staleSuggestion: 'A day has passed, so words like "tomorrow" no longer point to the same date. Tell me the date and I will add it.',
  repliesTitle: (count) => `${count} chats are waiting for a reply`,
  replyLine: (app, room, age, quote) =>
    `- ${EN_APP[app]} · ${room} · ${age} · "${quote}"`,
  repliedChoice: (room) => `Replied to ${room}`,
  muteRepliesLabel: 'Stop these reminders',
  repliedDone: (room) => `Marked ${room} as answered.`,
  muteRepliesDone: 'I will not send the reply reminder again.',
  muteUnavailable: 'The notice settings are not available.',
  ago: (hours, days) => (hours < 24 ? `${hours}h ago` : `${days}d ago`),
};

export function chatTexts(language: string): ChatInboxTexts {
  return language === 'en' ? EN : KO;
}
