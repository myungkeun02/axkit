import type { Weekday } from './date-spec.js';

/** Every spelling the owner may use for a weekday, in Korean or English. */
export const WEEKDAY_WORDS: Readonly<Record<Weekday, { ko: readonly string[]; en: readonly string[] }>> = {
  mon: { ko: ['월요일', '월욜', '(월)'], en: ['monday', 'mon'] },
  tue: { ko: ['화요일', '화욜', '(화)'], en: ['tuesday', 'tue', 'tues'] },
  wed: { ko: ['수요일', '수욜', '(수)'], en: ['wednesday', 'wed', 'weds'] },
  thu: { ko: ['목요일', '목욜', '(목)'], en: ['thursday', 'thu', 'thur', 'thurs'] },
  fri: { ko: ['금요일', '금욜', '(금)'], en: ['friday', 'fri'] },
  sat: { ko: ['토요일', '토욜', '(토)'], en: ['saturday', 'sat'] },
  sun: { ko: ['일요일', '일욜', '(일)'], en: ['sunday', 'sun'] },
};

/** Words that name a day relative to today, keyed by offset in days. */
export const OFFSET_WORDS: Readonly<Record<number, readonly string[]>> = {
  [-1]: ['어제', 'yesterday'],
  0: ['오늘', '금일', '오늘밤', 'today', 'tonight'],
  1: ['내일', '낼', 'tomorrow'],
  2: ['모레', 'day after tomorrow'],
  3: ['글피'],
};

/** Words that mark the week after this one (required for `week: 'next'`). */
export const NEXT_WEEK_WORDS: readonly string[] = ['다음 주', '다음주', '담주', 'next'];

/** Korean native-number hours; longer words first so 열두/열한 win over 열. */
export const KOREAN_HOUR_WORDS: readonly { hour: number; word: string }[] = [
  { hour: 12, word: '열두' },
  { hour: 11, word: '열한' },
  { hour: 10, word: '열' },
  { hour: 9, word: '아홉' },
  { hour: 8, word: '여덟' },
  { hour: 7, word: '일곱' },
  { hour: 6, word: '여섯' },
  { hour: 5, word: '다섯' },
  { hour: 4, word: '네' },
  { hour: 3, word: '세' },
  { hour: 2, word: '두' },
  { hour: 1, word: '한' },
];

/** English month names and abbreviations, January first. */
export const MONTH_NAMES_EN: readonly (readonly string[])[] = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['may'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sep', 'sept'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
];

export const NOON_WORDS: readonly string[] = ['정오', 'noon'];
export const MIDNIGHT_WORDS: readonly string[] = ['자정', 'midnight'];
export const HALF_WORDS: readonly string[] = ['반'];
