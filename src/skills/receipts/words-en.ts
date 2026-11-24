import type { DocKind } from './types.js';

export const EN_DOC_RULES: readonly { kind: DocKind; pattern: RegExp }[] = [
  { kind: 'receipt', pattern: /\breceipt\b|payment\s+(?:received|complete)/i },
  { kind: 'invoice', pattern: /\binvoice\b|\bbill(?:ing)?\b/i },
  { kind: 'contract', pattern: /\bcontract\b|\bagreement\b|\bsigned\b|please\s+sign/i },
  { kind: 'statement', pattern: /\bstatement\b/i },
];

export const EN_MARKETING = /\bnewsletter\b|\bpromotion\b|\bads?\b/i;

export const EN_TOTAL = /\btotal\b|\bamount(?:\s+due)?\b|grand\s+total|balance\s+due/i;
