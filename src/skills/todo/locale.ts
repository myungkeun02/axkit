import type { Weekday } from '../../core/time/date-spec.js';

export type SkillLanguage = 'ko' | 'en';

export interface TodoTexts {
  readonly language: SkillLanguage;
  readonly weekdays: Record<Weekday, string>;
  readonly months: readonly string[];
  readonly dueLabel: string;
  readonly remindLabel: string;
  readonly evidenceLabel: string;
  readonly completeLabel: string;
  readonly removeLabel: string;
  readonly reminderPrefix: string;
  readonly doneChoiceLabel: string;
  readonly snoozeChoiceLabel: string;
  readonly doneReplyPrefix: string;
  readonly snoozeReplyPrefix: string;
  readonly unknownItem: string;
  readonly alreadyDone: string;
  /** Localized wording for the English guesses produced by core/time/date-spec. */
  readonly guesses: Readonly<Record<string, string>>;
  readonly uncertain: string;
  /** Put on a to-do whose synced outside copy (Apple Reminders) vanished; the to-do is kept here. */
  readonly detachedNote: string;
}

const KO: TodoTexts = {
  language: 'ko',
  weekdays: { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' },
  months: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
  dueLabel: '마감',
  remindLabel: '알림',
  evidenceLabel: '근거',
  completeLabel: '완료',
  removeLabel: '할 일 삭제',
  reminderPrefix: '알림: ',
  doneChoiceLabel: '완료',
  snoozeChoiceLabel: '10분 뒤',
  doneReplyPrefix: '완료했어요: ',
  snoozeReplyPrefix: '10분 뒤에 다시 알려드릴게요: ',
  unknownItem: '그 할 일을 찾을 수 없어요.',
  alreadyDone: '이미 완료한 일이에요.',
  guesses: {
    'date is in the past': '날짜가 이미 지났어요',
    'already passed this week': '이번 주에서 그 요일은 이미 지났어요',
    'today or next week': '오늘이거나 다음 주일 수 있어요',
    'year inferred': '연도를 추측했어요',
    'AM/PM not stated': '오전/오후를 말하지 않아서 추측했어요',
  },
  uncertain: '날짜나 시간이 확실하지 않아요',
  detachedNote: '미리 알림에서 사라져서 이 맥에만 남겨 뒀어요',
};

const EN: TodoTexts = {
  language: 'en',
  weekdays: { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' },
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  dueLabel: 'Due',
  remindLabel: 'Remind',
  evidenceLabel: 'Evidence',
  completeLabel: 'Complete',
  removeLabel: 'Delete to-do',
  reminderPrefix: 'Reminder: ',
  doneChoiceLabel: 'Done',
  snoozeChoiceLabel: 'In 10 min',
  doneReplyPrefix: 'Done: ',
  snoozeReplyPrefix: "I'll remind you again in 10 minutes: ",
  unknownItem: 'I could not find that to-do.',
  alreadyDone: 'That to-do is already done.',
  guesses: {
    'date is in the past': 'that date is in the past',
    'already passed this week': 'that weekday already passed this week',
    'today or next week': 'it could be today or next week',
    'year inferred': 'the year was inferred',
    'AM/PM not stated': 'AM/PM was not stated, so I guessed',
  },
  uncertain: 'I am not sure about the date or time',
  detachedNote: 'Gone from Apple Reminders, so it is kept on this Mac only',
};

export function todoTexts(language: string): TodoTexts {
  return language === 'en' ? EN : KO;
}
