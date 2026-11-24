export const AREA_IDS = ['work', 'people', 'life', 'health', 'money', 'tech', 'interests', 'other'] as const;

export type AreaId = (typeof AREA_IDS)[number];

interface KeywordRule {
  area: AreaId;
  pattern: RegExp;
}

/** Order matters: the first area with a matching word wins. */
const KEYWORD_RULES: readonly KeywordRule[] = [
  { area: 'work', pattern: /회의|프로젝트|회사|업무|고객|\bwork\b|\bmeeting\b|\bproject\b|\bclient\b|\bcompany\b|\boffice\b/i },
  { area: 'people', pattern: /엄마|아빠|친구|가족|동료|님|\bmother\b|\bfather\b|\bfriend\b|\bfamily\b|\bcolleague\b|\bmom\b|\bdad\b/i },
  { area: 'health', pattern: /병원|운동|약|수면|\bhealth\b|\bhospital\b|\bexercise\b|\bsleep\b|\bmedicine\b|\bdoctor\b/i },
  { area: 'money', pattern: /카드|결제|월급|돈|비용|구독|\bmoney\b|\bcard\b|\bpayment\b|\bsalary\b|\bcost\b|\bsubscription\b|\bbudget\b/i },
  { area: 'tech', pattern: /코드|개발|서버|앱|\bAI\b|github|\bcode\b|\bdevelop\b|\bserver\b|\bapp\b|\bsoftware\b/i },
  { area: 'interests', pattern: /좋아|관심|취미|여행|음악|영화|\binterest\b|\bhobby\b|\btravel\b|\bmusic\b|\bmovie\b/i },
  { area: 'life', pattern: /집|이사|출근|요리|생활|\bhome\b|\bmove\b|\bcommute\b|\bcook\b|\blife\b/i },
];

/** Areas come from a model or from words; words alone never leave a fact unfiled. */
export function keywordArea(text: string): AreaId {
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(text)) return rule.area;
  }
  return 'other';
}
