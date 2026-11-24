export interface DocsTexts {
  none: string;
  listed(count: number, review: number): string;
  missing(id: string): string;
  reviewLabel: string;
  verified(title: string): string;
  verifyDescription(title: string): string;
}

const ko: DocsTexts = {
  none: '아직 정리된 문서가 없어요.',
  listed: (count, review) => (review > 0 ? `문서 ${count}개, 그중 ${review}개는 다시 확인이 필요해요.` : `문서 ${count}개예요.`),
  missing: (id) => `'${id}' 문서를 찾지 못했어요.`,
  reviewLabel: '다시 확인 필요',
  verified: (title) => `'${title}' 문서를 지금 내용 그대로 맞다고 표시했어요.`,
  verifyDescription: (title) => `'${title}' 문서를 아직 맞는 내용으로 표시`,
};

const en: DocsTexts = {
  none: 'No documents yet.',
  listed: (count, review) => (review > 0 ? `${count} documents, ${review} need another look.` : `${count} documents.`),
  missing: (id) => `No document '${id}'.`,
  reviewLabel: 'Needs review',
  verified: (title) => `Marked '${title}' as still correct.`,
  verifyDescription: (title) => `Mark '${title}' as still correct`,
};

export function docsTexts(language: string): DocsTexts {
  return language === 'en' ? en : ko;
}
