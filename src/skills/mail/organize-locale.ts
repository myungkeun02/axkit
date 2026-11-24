export type MailCategory = 'promotions' | 'social' | 'updates' | 'forums';

export interface OrganizeTexts {
  /** The plain how-to when Gmail 정리 (gmail.modify) was never granted. */
  readonly needsPermission: string;
  readonly archiveLabel: (count: number) => string;
  readonly addLabel: (names: string) => string;
  readonly removeLabel: (names: string) => string;
  readonly more: (count: number) => string;
  readonly noSubject: string;
  readonly categoryName: (category: MailCategory) => string;
  readonly fromWho: (who: string) => string;
  readonly archiveScope: (who: string) => string;
  readonly labelScope: (who: string, change: string) => string;
  readonly changed: string;
  readonly forbidden: string;
  readonly nothingToChange: string;
  readonly unknownLabel: (name: string) => string;
}

const KO_CATEGORY: Record<MailCategory, string> = {
  promotions: '광고(프로모션)',
  social: '소셜',
  updates: '알림(업데이트)',
  forums: '포럼',
};

const KO: OrganizeTexts = {
  needsPermission:
    'Gmail 정리(보관·라벨) 권한이 아직 없어요. 맥 터미널에서 ax-kit connect google 을 다시 실행해 "Gmail 정리"를 고르고, ' +
    'Google 화면에서 허락해 주세요. 메일을 지우거나 휴지통에 넣는 권한은 쓰지 않아요.',
  archiveLabel: (count) => `메일 ${count}통 보관 (받은편지함에서만 빼요, 지우지 않아요)`,
  addLabel: (names) => `라벨 붙이기: ${names} (없는 라벨은 새로 만들어요)`,
  removeLabel: (names) => `라벨 떼기: ${names}`,
  more: (count) => `외 ${count}통`,
  noSubject: '(제목 없음)',
  categoryName: (category) => `${KO_CATEGORY[category]}`,
  fromWho: (who) => `${who}에서 온`,
  archiveScope: (who) => `앞으로 ${who} 메일은 묻지 않고 보관할게요`,
  labelScope: (who, change) => `앞으로 ${who} 메일의 라벨 바꾸기(${change})는 묻지 않고 할게요`,
  changed: '메일이 그사이 바뀌었어요(보낸 사람이나 제목이 달라요). 아무것도 바꾸지 않았어요. mail.search로 다시 찾아 주세요.',
  forbidden: '휴지통·스팸으로 옮기거나 지우는 일은 하지 않아요. 보관(받은편지함에서 빼기)이나 라벨만 바꿀 수 있어요.',
  nothingToChange: '붙이거나 뗄 라벨을 하나 이상 알려 주세요.',
  unknownLabel: (name) => `'${name}' 라벨이 메일함에 없어요. mail.labels로 이름을 확인해 주세요.`,
};

const EN_CATEGORY: Record<MailCategory, string> = {
  promotions: 'promotions',
  social: 'social',
  updates: 'updates',
  forums: 'forums',
};

const EN: OrganizeTexts = {
  needsPermission:
    'Gmail organizing (archive, labels) is not allowed yet. On the Mac, run ax-kit connect google again, pick ' +
    '"Gmail 정리" and allow it on the Google screen. Mail is never deleted or trashed.',
  archiveLabel: (count) => `Archive ${count} mails (out of the inbox only, nothing is deleted)`,
  addLabel: (names) => `Add labels: ${names} (missing labels are created)`,
  removeLabel: (names) => `Remove labels: ${names}`,
  more: (count) => `and ${count} more`,
  noSubject: '(no subject)',
  categoryName: (category) => EN_CATEGORY[category],
  fromWho: (who) => `from ${who}`,
  archiveScope: (who) => `From now on, archive ${who} mail without asking`,
  labelScope: (who, change) => `From now on, change labels (${change}) on ${who} mail without asking`,
  changed: 'The mail changed in the meantime (sender or subject differ). Nothing was changed; search again with mail.search.',
  forbidden: 'Mail is never moved to trash or spam, or deleted. Only archiving and labels can change.',
  nothingToChange: 'Give at least one label to add or remove.',
  unknownLabel: (name) => `There is no "${name}" label in the mailbox. Check the names with mail.labels.`,
};

export function organizeTexts(language: string): OrganizeTexts {
  return language === 'en' ? EN : KO;
}
