import type { Weekday } from '../../core/time/date-spec.js';

export type SkillLanguage = 'ko' | 'en';

export interface CalendarTexts {
  readonly language: SkillLanguage;
  readonly weekdays: Record<Weekday, string>;
  /** Month labels, January first ("1월", "Jan"). */
  readonly months: readonly string[];
  readonly allDay: string;
  readonly timeSeparator: string;
  readonly locationLabel: string;
  readonly attendeesLabel: string;
  readonly calendarLabel: string;
  readonly inviteNote: string;
  readonly evidenceLabel: string;
  /** Localized wording for the English guesses produced by core/time/date-spec. */
  readonly guesses: Readonly<Record<string, string>>;
  readonly uncertain: string;
}

const KO: CalendarTexts = {
  language: 'ko',
  weekdays: { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' },
  months: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
  allDay: '종일',
  timeSeparator: '–',
  locationLabel: '위치',
  attendeesLabel: '참석자',
  calendarLabel: '캘린더',
  inviteNote: '초대 메일이 가요',
  evidenceLabel: '근거',
  guesses: {
    'date is in the past': '날짜가 이미 지났어요',
    'already passed this week': '이번 주에서 그 요일은 이미 지났어요',
    'today or next week': '오늘이거나 다음 주일 수 있어요',
    'year inferred': '연도를 추측했어요',
    'AM/PM not stated': '오전/오후를 말하지 않아서 추측했어요',
  },
  uncertain: '날짜나 시간이 확실하지 않아요',
};

const EN: CalendarTexts = {
  language: 'en',
  weekdays: { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' },
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  allDay: 'All day',
  timeSeparator: '–',
  locationLabel: 'Location',
  attendeesLabel: 'Attendees',
  calendarLabel: 'Calendar',
  inviteNote: 'Invitations will be emailed',
  evidenceLabel: 'Evidence',
  guesses: {
    'date is in the past': 'that date is in the past',
    'already passed this week': 'that weekday already passed this week',
    'today or next week': 'it could be today or next week',
    'year inferred': 'the year was inferred',
    'AM/PM not stated': 'AM/PM was not stated, so I guessed',
  },
  uncertain: 'I am not sure about the date or time',
};

export function calendarTexts(language: string): CalendarTexts {
  return language === 'en' ? EN : KO;
}
