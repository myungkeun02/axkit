import type { SpendCategory } from '../../core/contracts/index.js';
import { SPEND_CATEGORIES } from '../../core/contracts/index.js';
import type { InsightTexts } from './locale-insights.js';
import { insightTexts } from './locale-insights.js';

export type SpendingLanguage = 'ko' | 'en';

export interface SpendingTexts extends InsightTexts {
  readonly language: SpendingLanguage;
  readonly receiptQuery: string;
  category(category: SpendCategory): string;
  money(amount: number, currency: string): string;
  addDescription(merchant: string, amount: number, currency: string, category: string | undefined): string;
  setCategoryDescription(merchant: string, category: string): string;
  excludeDescription(merchant: string, amount: string | undefined, excluded: boolean): string;
  readonly noMerchant: string;
}

type CategoryLabels = Record<SpendCategory, string>;

function labels(values: CategoryLabels): CategoryLabels {
  for (const category of SPEND_CATEGORIES) {
    if (values[category] === '') throw new Error(`missing category label: ${category}`);
  }
  return values;
}

const KO_LABELS = labels({
  food: '식비',
  cafe: '카페',
  groceries: '장보기',
  transport: '교통',
  shopping: '쇼핑',
  living: '생활·공과금',
  health: '의료',
  culture: '문화',
  travel: '여행',
  education: '교육',
  subscription: '구독',
  ai: 'AI 서비스',
  infra: '인프라',
  transfer: '이체',
  other: '기타',
});

const EN_LABELS = labels({
  food: 'Food',
  cafe: 'Cafe',
  groceries: 'Groceries',
  transport: 'Transport',
  shopping: 'Shopping',
  living: 'Living',
  health: 'Health',
  culture: 'Culture',
  travel: 'Travel',
  education: 'Education',
  subscription: 'Subscription',
  ai: 'AI services',
  infra: 'Infrastructure',
  transfer: 'Transfer',
  other: 'Other',
});

function koMoney(amount: number, currency: string): string {
  if (currency.toUpperCase() === 'KRW') {
    return `${Math.round(amount).toLocaleString('ko-KR')}원`;
  }
  return `${amount.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} ${currency.toUpperCase()}`;
}

function enMoney(amount: number, currency: string): string {
  const digits = currency.toUpperCase() === 'KRW' ? 0 : 2;
  return `${currency.toUpperCase()} ${amount.toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}

const KO: SpendingTexts = {
  ...insightTexts('ko'),
  language: 'ko',
  receiptQuery: '영수증 OR 결제 완료 OR 구매 완료 OR 주문 완료 OR 결제 내역',
  category: (category) => KO_LABELS[category],
  money: koMoney,
  addDescription: (merchant, amount, currency, category) => {
    const tail = category === undefined ? '' : ` · ${category}`;
    return `지출 추가: ${merchant} ${koMoney(amount, currency)}${tail}`;
  },
  setCategoryDescription: (merchant, category) => `분류 변경: ${merchant} → ${category}`,
  excludeDescription: (merchant, amount, excluded) => {
    const subject = amount === undefined ? merchant : `${merchant} ${amount}`;
    return excluded ? `지출에서 제외: ${subject}` : `지출에 포함: ${subject}`;
  },
  noMerchant: '가맹점 없음',
};

const EN: SpendingTexts = {
  ...insightTexts('en'),
  language: 'en',
  receiptQuery: 'receipt OR "payment received" OR "order confirmation" OR "invoice paid"',
  category: (category) => EN_LABELS[category],
  money: enMoney,
  addDescription: (merchant, amount, currency, category) => {
    const tail = category === undefined ? '' : ` · ${category}`;
    return `Add spend: ${merchant} ${enMoney(amount, currency)}${tail}`;
  },
  setCategoryDescription: (merchant, category) => `Change category: ${merchant} → ${category}`,
  excludeDescription: (merchant, amount, excluded) => {
    const subject = amount === undefined ? merchant : `${merchant} ${amount}`;
    return excluded ? `Exclude from spend: ${subject}` : `Include in spend: ${subject}`;
  },
  noMerchant: 'No merchant',
};

export function spendingTexts(language: string): SpendingTexts {
  return language === 'en' ? EN : KO;
}
