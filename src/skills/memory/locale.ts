export type SkillLanguage = 'ko' | 'en';

export interface MemoryTexts {
  readonly language: SkillLanguage;
  readonly rememberLabel: string;
  readonly forgetLabel: string;
  readonly noteLabel: string;
  readonly doneLabel: string;
  readonly meetingPrefix: string;
  readonly checkinTitle: string;
  readonly checkinQuestion: string;
  readonly checkinKeepLabel: string;
  readonly checkinForgetLabel: string;
  checkinKept(text: string): string;
  checkinForgotten(text: string): string;
  readonly checkinKeptAsIs: string;
  readonly checkinGone: string;
  readonly checkinFailed: string;
  /** Marks a fact whose end condition has passed in the check-in notice. */
  readonly checkinExpiredMark: string;
  /** Asked when a time-limited phrase appears without a date or event. */
  readonly askEnd: string;
  eventEnded(count: number): string;
  readonly eventLabel: string;
  expiredFactsLine(count: number, first: string): string;
  readonly expiredFactsNone: string;
  readonly expiredFactsFix: string;
  /** Korean particles that can trail a name in a sentence. */
  readonly particles: readonly string[];
  /** Honorifics and role words that are not part of a person's name. */
  readonly personSuffixes: readonly string[];
  readonly personPrefixes: readonly string[];
}

const KO_PARTICLES = [
  '이랑',
  '하고',
  '한테',
  '에게',
  '에서',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '에',
  '의',
  '도',
  '랑',
  '와',
  '과',
  '님',
];

const KO_ROLES = [
  '선생님',
  '선배',
  '후배',
  '누나',
  '언니',
  '오빠',
  '팀장',
  '과장',
  '부장',
  '실장',
  '교수',
  '대표',
  '형',
  '씨',
  '쌤',
  '님',
];

const EN_PREFIXES = ['mr.', 'mrs.', 'ms.', 'dr.', 'miss'];

const KO: MemoryTexts = {
  language: 'ko',
  rememberLabel: '기억 저장',
  forgetLabel: '기억 삭제',
  noteLabel: '약속 기록',
  doneLabel: '약속 완료',
  meetingPrefix: '만남: ',
  checkinTitle: '기억 정리',
  checkinQuestion: '아직 맞나요?',
  checkinKeepLabel: '맞아요',
  checkinForgetLabel: '이제 아니에요',
  checkinKept: (text) => `기억해 둘게요: ${text}`,
  checkinForgotten: (text) => `지웠어요: ${text}`,
  checkinKeptAsIs: '그대로 두었어요.',
  checkinGone: '이 기억은 이미 없어요.',
  checkinFailed: '지우지 못했어요. 잠시 뒤에 다시 시도해 주세요.',
  checkinExpiredMark: '끝난 것 같아요',
  askEnd: '언제까지 맞는 사실인가요? 날짜나 일(예: 출시)을 알려 주시면 그때 다시 여쭤볼게요.',
  eventEnded: (count) => `${count}개 사실을 끝난 것으로 표시했어요.`,
  eventLabel: '끝난 일 기록',
  expiredFactsLine: (count, first) => `끝난 기억이 ${count}개 있어요. 먼저 '${first}'를 다시 확인해 주세요.`,
  expiredFactsNone: '끝났는데 아직 정리하지 않은 기억이 없어요.',
  expiredFactsFix: '기억 정리에서 맞는지 확인하거나 지워 주세요.',
  particles: KO_PARTICLES,
  personSuffixes: KO_ROLES,
  personPrefixes: EN_PREFIXES,
};

const EN: MemoryTexts = {
  language: 'en',
  rememberLabel: 'Remember',
  forgetLabel: 'Forget',
  noteLabel: 'Record commitment',
  doneLabel: 'Complete commitment',
  meetingPrefix: 'Meeting: ',
  checkinTitle: 'Memory check-in',
  checkinQuestion: 'Is this still right?',
  checkinKeepLabel: 'Yes, still right',
  checkinForgetLabel: 'No longer true',
  checkinKept: (text) => `I will keep it: ${text}`,
  checkinForgotten: (text) => `I removed it: ${text}`,
  checkinKeptAsIs: 'I left it as it was.',
  checkinGone: 'That memory is already gone.',
  checkinFailed: 'I could not remove it. Please try again later.',
  checkinExpiredMark: 'may have ended',
  askEnd: 'How long is this true? Tell me a date or an event (for example a launch), and I will ask again then.',
  eventEnded: (count) => `I marked ${count} ${count === 1 ? 'fact' : 'facts'} as ended.`,
  eventLabel: 'Record ended event',
  expiredFactsLine: (count, first) =>
    `${count} ended ${count === 1 ? 'fact needs' : 'facts need'} another look. Start with "${first}".`,
  expiredFactsNone: 'No ended facts are waiting to be reviewed.',
  expiredFactsFix: 'Confirm each one in the memory check-in or remove it.',
  particles: KO_PARTICLES,
  personSuffixes: KO_ROLES,
  personPrefixes: EN_PREFIXES,
};

export function memoryTexts(language: string): MemoryTexts {
  return language === 'en' ? EN : KO;
}
