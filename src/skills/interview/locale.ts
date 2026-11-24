export type SkillLanguage = 'ko' | 'en';

export interface InterviewTexts {
  readonly language: SkillLanguage;
  readonly intro: string;
  readonly thanks: string;
  readonly skipped: string;
  readonly finished: string;
  readonly skip: string;
}

const KO: InterviewTexts = {
  language: 'ko',
  intro: '몇 가지만 여쭤볼게요. 답해 주시면 제가 기억해 둘게요.',
  thanks: '기억해 둘게요.',
  skipped: '이번 질문은 건너뛸게요.',
  finished: '질문은 다 끝났어요.',
  skip: '건너뛰기',
};

const EN: InterviewTexts = {
  language: 'en',
  intro: "I'd like to ask a few things about you. Your answers help me remember.",
  thanks: "Got it, I'll remember that.",
  skipped: 'Skipping this one.',
  finished: "That's all the questions.",
  skip: 'Skip',
};

export function interviewTexts(language: string): InterviewTexts {
  return language === 'en' ? EN : KO;
}
