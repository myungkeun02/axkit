import type { Weekday } from '../../core/time/date-spec.js';

export interface SectionTexts {
  calendar: string;
  mail: string;
  todo: string;
}

/** Every sentence the briefing shows. Korean is the default. */
export interface BriefingTexts {
  greeting(ownerName: string | undefined, date: string): string;
  date(month: number, day: number, weekday: Weekday): string;
  titles: SectionTexts;
  empty: SectionTexts;
  notConnected: SectionTexts;
  failed: SectionTexts;
  choices: SectionTexts;
  allDay: string;
  overdueMark: string;
  weather: string;
  dust: string;
  airGrade(grade: string): string;
}

const KO_WEEKDAYS: Record<Weekday, string> = {
  mon: '월',
  tue: '화',
  wed: '수',
  thu: '목',
  fri: '금',
  sat: '토',
  sun: '일',
};

const EN_WEEKDAYS: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const KO: BriefingTexts = {
  greeting: (ownerName, date) =>
    ownerName === undefined
      ? `좋은 아침이에요. ${date} 브리핑이에요.`
      : `좋은 아침이에요, ${ownerName}님. ${date} 브리핑이에요.`,
  date: (month, day, weekday) => `${month}월 ${day}일 (${KO_WEEKDAYS[weekday]})`,
  titles: { calendar: '일정', mail: '중요 메일', todo: '할 일' },
  empty: {
    calendar: '오늘 일정은 없어요.',
    mail: '중요한 메일은 없어요.',
    todo: '할 일은 없어요.',
  },
  notConnected: {
    calendar: 'Google 캘린더가 연결되지 않았어요 (ax-kit connect google)',
    mail: 'Gmail이 연결되지 않았어요 (ax-kit connect google)',
    todo: '할 일 목록이 연결되지 않았어요.',
  },
  failed: {
    calendar: '일정을 불러오지 못했어요.',
    mail: '메일을 불러오지 못했어요.',
    todo: '할 일을 불러오지 못했어요.',
  },
  choices: {
    calendar: '오늘 일정 자세히',
    mail: '중요 메일 요약',
    todo: '할 일 정리',
  },
  allDay: '종일',
  overdueMark: '(지남)',
  weather: '날씨',
  dust: '미세먼지',
  airGrade: (grade) => grade,
};

const EN_AIR_GRADES: Readonly<Record<string, string>> = {
  좋음: 'good',
  보통: 'moderate',
  나쁨: 'bad',
  매우나쁨: 'very bad',
  '매우 나쁨': 'very bad',
};

const EN: BriefingTexts = {
  greeting: (ownerName, date) =>
    ownerName === undefined
      ? `Good morning. Here is your briefing for ${date}.`
      : `Good morning, ${ownerName}. Here is your briefing for ${date}.`,
  date: (month, day, weekday) => `${EN_WEEKDAYS[weekday]}, ${EN_MONTHS[month - 1] ?? ''} ${day}`,
  titles: { calendar: 'Schedule', mail: 'Important mail', todo: 'To-do' },
  empty: {
    calendar: 'No events today.',
    mail: 'No important mail.',
    todo: 'Nothing on your list.',
  },
  notConnected: {
    calendar: 'Google Calendar is not connected (ax-kit connect google)',
    mail: 'Gmail is not connected (ax-kit connect google)',
    todo: 'Your to-do list is not connected.',
  },
  failed: {
    calendar: 'Could not load your schedule.',
    mail: 'Could not load your mail.',
    todo: 'Could not load your to-dos.',
  },
  choices: {
    calendar: "Today's schedule in detail",
    mail: 'Summarize important mail',
    todo: 'Organize to-dos',
  },
  allDay: 'All day',
  overdueMark: '(overdue)',
  weather: 'Weather',
  dust: 'fine dust',
  airGrade: (grade) => EN_AIR_GRADES[grade] ?? grade,
};

export function briefingTexts(language: string): BriefingTexts {
  return language === 'en' ? EN : KO;
}
