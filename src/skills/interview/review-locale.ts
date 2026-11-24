export type SkillLanguage = 'ko' | 'en';

export interface ReviewTexts {
  readonly language: SkillLanguage;
  readonly allCorrect: string;
  readonly fixLine: string;
  readonly cardHint: string;
  readonly confirmed: string;
  readonly instructions: string;
  readonly range: (max: number) => string;
  readonly corrected: (numbers: readonly number[]) => string;
  readonly removed: (numbers: readonly number[]) => string;
  readonly finished: string;
  readonly cardAgain: string;
  readonly noCard: string;
}

const KO: ReviewTexts = {
  language: 'ko',
  allCorrect: '다 맞아요',
  fixLine: '고칠 줄 있어요',
  cardHint: '맞는지 봐 주세요. 틀린 줄이 있으면 [고칠 줄 있어요]를 누르고 번호로 고쳐 주세요 (예: 2 회사는 ○○예요).',
  confirmed: '확인해 주셔서 고마워요.',
  instructions:
    "틀린 줄 번호와 바른 내용을 적어 주세요. 예) 2 회사는 ○○예요 / 3 삭제. 다 고치셨으면 '끝'이라고 해 주세요.",
  range: (max) => `1번부터 ${max}번 사이의 번호로 적어 주세요.`,
  corrected: (numbers) => `${numbers.join(', ')}번 고쳤어요.`,
  removed: (numbers) => `${numbers.join(', ')}번 지웠어요.`,
  finished: '고친 내용을 반영했어요. 고마워요.',
  cardAgain: '확인 카드를 다시 보여 드릴게요.',
  noCard: '다시 보여 드릴 확인 카드가 없어요.',
};

const EN: ReviewTexts = {
  language: 'en',
  allCorrect: 'All correct',
  fixLine: 'Fix a line',
  cardHint: 'Please check these. If a line is wrong, press [Fix a line] and fix it by number (e.g. 2 I work at ...).',
  confirmed: 'Thanks for checking.',
  instructions:
    'Send the wrong line number and the correct text. Example: 2 The company is Acme / 3 remove. Say "done" when you are finished.',
  range: (max) => `Use a number between 1 and ${max}.`,
  corrected: (numbers) => `Updated line${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')}.`,
  removed: (numbers) => `Removed line${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')}.`,
  finished: 'I applied your fixes. Thank you.',
  cardAgain: 'Here is the review card again.',
  noCard: 'There is no review card to show again.',
};

export function interviewReviewTexts(language: string): ReviewTexts {
  return language === 'en' ? EN : KO;
}
