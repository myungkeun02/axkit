export type SkillLanguage = 'ko' | 'en';

export interface MailTexts {
  readonly language: SkillLanguage;
  readonly toLabel: string;
  readonly ccLabel: string;
  readonly subjectLabel: string;
  readonly bodyLabel: string;
  readonly none: string;
  /** Suffix appended to a body cut for the approval card. */
  readonly truncatedSuffix: string;
  readonly draftLabel: string;
  readonly attachLabel: string;
}

const KO: MailTexts = {
  language: 'ko',
  toLabel: '받는 사람',
  ccLabel: '참조',
  subjectLabel: '제목',
  bodyLabel: '본문',
  none: '없음',
  truncatedSuffix: '…(이하 생략)',
  draftLabel: '답장 초안',
  attachLabel: '첨부',
};

const EN: MailTexts = {
  language: 'en',
  toLabel: 'To',
  ccLabel: 'Cc',
  subjectLabel: 'Subject',
  bodyLabel: 'Body',
  none: 'none',
  truncatedSuffix: '…(truncated)',
  draftLabel: 'Reply draft',
  attachLabel: 'Attached',
};

export function mailTexts(language: string): MailTexts {
  return language === 'en' ? EN : KO;
}
