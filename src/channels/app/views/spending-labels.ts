import type { SpendCategory } from '../../../core/contracts/index.js';

/** Category names for app screens (the same words skill.spending uses; channels cannot import skills). */
const KO: Record<SpendCategory, string> = {
  food: '식비', cafe: '카페', groceries: '장보기', transport: '교통', shopping: '쇼핑', living: '생활·공과금', health: '의료',
  culture: '문화', travel: '여행', education: '교육', subscription: '구독', ai: 'AI 서비스', infra: '인프라', transfer: '이체', other: '기타',
};

const EN: Record<SpendCategory, string> = {
  food: 'Food', cafe: 'Cafe', groceries: 'Groceries', transport: 'Transport', shopping: 'Shopping', living: 'Living', health: 'Health',
  culture: 'Culture', travel: 'Travel', education: 'Education', subscription: 'Subscription', ai: 'AI services', infra: 'Infrastructure',
  transfer: 'Transfer', other: 'Other',
};

export function categoryLabel(category: string, language: string): string {
  const table = language === 'en' ? EN : KO;
  return (table as Record<string, string>)[category] ?? category;
}
