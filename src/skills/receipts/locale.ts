import type { DocKind } from './types.js';

export type ReceiptsLanguage = 'ko' | 'en';

export interface ReceiptsTexts {
  readonly language: ReceiptsLanguage;
  readonly searchQuery: string;
  kindLabel(kind: DocKind): string;
  formatMoney(amount: number, currency: string): string;
  monthEndTitle(ym: string): string;
  kindCount(kind: DocKind, count: number): string;
  receiptSum(amount: number, currency: string): string;
  readonly missingTitle: string;
  readonly missingNote: string;
  missingLine(mmdd: string, merchant: string, amount: string): string;
}

const KO_LABELS: Record<DocKind, string> = {
  receipt: '영수증',
  invoice: '인보이스',
  contract: '계약서',
  statement: '명세서',
};

const EN_LABELS: Record<DocKind, string> = {
  receipt: 'Receipts',
  invoice: 'Invoices',
  contract: 'Contracts',
  statement: 'Statements',
};

const KO: ReceiptsTexts = {
  language: 'ko',
  searchQuery:
    '영수증 OR 인보이스 OR 청구서 OR 계약서 OR 세금계산서 OR 명세서 OR receipt OR invoice OR contract OR statement',
  kindLabel: (kind) => KO_LABELS[kind],
  formatMoney: (amount, currency) => {
    const number = amount.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
    return currency.toUpperCase() === 'KRW' ? `${number}원` : `${number} ${currency}`;
  },
  monthEndTitle: (ym) => `${ym} 서류 정리`,
  kindCount: (kind, count) => `${KO_LABELS[kind]} ${count}건`,
  receiptSum: (amount, currency) => `영수증 합계: ${KO.formatMoney(amount, currency)}`,
  missingTitle: '메일 영수증을 못 찾은 결제',
  missingNote: '오프라인 결제라 메일 영수증이 없을 수 있어요.',
  missingLine: (mmdd, merchant, amount) => `${mmdd} ${merchant} ${amount}`,
};

const EN: ReceiptsTexts = {
  language: 'en',
  searchQuery: 'receipt OR invoice OR bill OR contract OR statement',
  kindLabel: (kind) => EN_LABELS[kind],
  formatMoney: (amount, currency) => {
    const number = amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return currency.toUpperCase() === 'KRW' ? `${number} KRW` : `${number} ${currency}`;
  },
  monthEndTitle: (ym) => `Documents for ${ym}`,
  kindCount: (kind, count) => `${EN_LABELS[kind]}: ${count}`,
  receiptSum: (amount, currency) => `Receipts total: ${EN.formatMoney(amount, currency)}`,
  missingTitle: 'Charges with no mail receipt',
  missingNote: 'These may be offline purchases that never had a mail receipt.',
  missingLine: (mmdd, merchant, amount) => `${mmdd} ${merchant} ${amount}`,
};

export function receiptsTexts(language: string): ReceiptsTexts {
  return language === 'en' ? EN : KO;
}
