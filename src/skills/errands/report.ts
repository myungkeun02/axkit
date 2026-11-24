/** Reads the browser's `KEY: value` report and the page words that mean the owner must decide first. */

const KEYS = [
  'TRAIN', 'DEPART', 'ARRIVE', 'SEAT', 'SEATS', 'PRICE', 'DEADLINE',
  'PLACE', 'DATE', 'TIME', 'PARTY', 'OPTION', 'AVAILABLE', 'DEPOSIT', 'CANCEL', 'OTHER_TIMES',
  'ITEM', 'OPTIONS', 'QUANTITY', 'DELIVERY', 'TOTAL', 'SELLER', 'ADDED',
] as const;
const MAX_VALUE = 120;

/** Only known keys, each value one short line. Page-derived: shown as data, never followed. */
export function reportDetails(text: string): Record<string, string> {
  const details: Record<string, string> = {};
  const pattern = new RegExp(`\\b(${KEYS.join('|')})\\s*:\\s*([^;\\n]+)`, 'g');
  for (const match of text.matchAll(pattern)) {
    const key = match[1];
    const value = match[2]?.trim().replace(/\s+/g, ' ');
    if (key === undefined || value === undefined || value === '' || details[key] !== undefined) continue;
    details[key] = value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value;
  }
  return details;
}

const NO = /^(?:no|none|없음|아니요|x|0|n\/a|-)(?![a-z])/i;
const YES = /^(?:yes|있음|가능|o|y)(?![a-z])/i;

export function saysNo(value: string | undefined): boolean {
  return value !== undefined && NO.test(value.trim());
}

export function saysYes(value: string | undefined): boolean {
  return value !== undefined && YES.test(value.trim());
}

const DEPOSIT_WORDS = /예약금|선결제|선입금|보증금|노쇼\s*(?:위약금|수수료)|위약금|deposit|prepay|no-?show fee/i;
const UNKNOWN = /^(?:unknown|unclear|모름|불명|확인\s*안\s*됨|없음|none|n\/a|-)(?![a-z])/i;

/** A deposit or prepayment the owner did not see yet: stated in the report, or in the page words around it. */
export function hasDeposit(details: Record<string, string>, text: string): boolean {
  const reported = details['DEPOSIT'];
  if (reported !== undefined) return !saysNo(reported);
  return DEPOSIT_WORDS.test(text);
}

/** A cancellation rule the browser could not read plainly counts as unclear. */
export function cancellationUnclear(details: Record<string, string>): boolean {
  const rule = details['CANCEL'];
  return rule === undefined || UNKNOWN.test(rule.trim());
}

/**
 * Words that would mean something was committed in the owner's name. The harness refuses those buttons, so this is
 * a second net (a CLI adapter, a page that committed on its own): the owner is told to check right away.
 */
const COMMITTED = /예약(?:이)?\s*(?:완료|확정)되|예매(?:가)?\s*완료|결제(?:가)?\s*완료|주문(?:이)?\s*완료|booking confirmed|order placed|payment complete/i;

export function looksCommitted(text: string): boolean {
  return COMMITTED.test(text);
}
