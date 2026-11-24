/**
 * Korean SMS rules, plus the language-neutral parts of one-time-code detection. Other languages add their own
 * word lists next to this file; the pipeline only consumes the exported predicates.
 */
const OTP_CONTEXT =
  /(인증|인증번호|승인번호|확인\s*코드|보안\s*코드|verification|verify|one[-\s]?time|passcode|\bOTP\b|\bcode\b|코드)/i;
const OTP_CODE = /(?<![\d-])(?:[A-Za-z]-)?(\d{4,8})(?![\d-])/;

const CARD_APPROVAL =
  /(승인|결제|일시불|할부|취소).{0,40}\d[\d,]*\s*원|\d[\d,]*\s*원.{0,40}(승인|결제|일시불|할부)/;

const FOREIGN_CURRENCIES = [
  'USD',
  'EUR',
  'JPY',
  'GBP',
  'CNY',
  'AUD',
  'CAD',
  'HKD',
  'SGD',
  'TWD',
  'CHF',
  'THB',
  'VND',
  'PHP',
  'MYR',
  'NZD',
  'SEK',
  'NOK',
  'DKK',
  'AED',
  'SAR',
  'RUB',
].join('|');

// A foreign amount only counts when the notice also uses card wording; prices in ads do not.
const FOREIGN_AMOUNT = new RegExp(
  `\\b(?:${FOREIGN_CURRENCIES}|US\\$)\\s*\\$?\\s*\\d[\\d,.]*|\\d[\\d,.]*\\s*(?:${FOREIGN_CURRENCIES})\\b`,
  'i',
);
const CARD_ACTION = /(승인|결제|취소|해외)/;

const BLOCK_RULES: readonly RegExp[] = [
  /[([]\s*광고\s*[)\]]/,
  /무료\s*(수신)?\s*거부|수신\s*거부|080-?\d{3,4}-?\d{4}/,
  /무직자|저금리\s*대출|대출\s*가능|한도\s*조회|정부\s*지원\s*(자금|대출)/,
  /카지노|바카라|토토|슬롯|입플|첫충|환전\s*보장/,
  /리딩방|급등주|종목\s*추천|무료\s*추천주|코인\s*수익|수익\s*인증|선물\s*옵션/,
  /(당첨|경품|환급금|미수령).{0,30}(https?:\/\/|www\.|\.ly\/|링크|클릭)/i,
];

/** A code in a message that also reads like verification mail; undefined when the text has no usable code. */
export function extractOneTimeCode(text: string): string | undefined {
  if (!OTP_CONTEXT.test(text)) return undefined;
  return OTP_CODE.exec(text)?.[1];
}

export function isCardApproval(text: string): boolean {
  if (isSpam(text, undefined)) return false;
  return CARD_APPROVAL.test(text) || (FOREIGN_AMOUNT.test(text) && CARD_ACTION.test(text));
}

export function isSpam(text: string, sender: string | undefined): boolean {
  const haystack = `${sender ?? ''}\n${text}`;
  return BLOCK_RULES.some((rule) => rule.test(haystack));
}
