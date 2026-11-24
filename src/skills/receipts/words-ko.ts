import type { DocKind } from './types.js';

export const KO_DOC_RULES: readonly { kind: DocKind; pattern: RegExp }[] = [
  { kind: 'receipt', pattern: /영수증|결제\s*(?:가\s*)?완료|구매\s*(?:가\s*)?확인/ },
  { kind: 'invoice', pattern: /인보이스|청구서|세금\s*계산서/ },
  { kind: 'contract', pattern: /계약서|전자\s*계약|서명\s*요청|약관\s*동의서/ },
  { kind: 'statement', pattern: /명세서|이용\s*내역/ },
];

export const KO_MARKETING = /광고|뉴스레터|프로모션|쿠폰|할인\s*혜택/;

export const KO_TOTAL = /합계|총\s*(?:액|금액|결제)?|결제\s*금액/;
