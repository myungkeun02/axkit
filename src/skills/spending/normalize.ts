const KOREAN_COMPANY = /주식회사|유한회사|\(주\)|㈜/g;
const COMPANY_SUFFIX = /\b(?:inc|llc|ltd|pbc|corp|co|gmbh)\b\.?/gi;
/** A token that may be a card number: at least four digits, stars, or hyphen-grouped digits. */
const CARD_LIKE = /[\d*][\d*-]{2,}[\d*]/g;
const FULL_CARD_NUMBER = /^\d{4}(?:-\d{4}){2,}$/;

export function merchantKey(name: string): string {
  const stripped = name.replace(KOREAN_COMPANY, ' ').replace(COMPANY_SUFFIX, ' ');
  return stripped.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Removes card-number-shaped digit runs so they never reach the ledger or a model. Dates and comma-grouped
 * amounts are kept: only star-masked tokens, long digit runs and four-digit hyphen groups look like cards.
 */
export function stripCardNumbers(text: string): string {
  return text.replace(CARD_LIKE, (token) => {
    if (!/\d/.test(token)) return token;
    const masked = token.includes('*');
    const longRun = /^\d{4,}$/.test(token);
    const grouped = FULL_CARD_NUMBER.test(token);
    return masked || longRun || grouped ? ' ' : token;
  });
}

export function cleanMerchant(name: string): string {
  return stripCardNumbers(name).replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** Merchant keys are the same payment when equal, or when one contains the other and both are long enough. */
export function merchantsMatch(left: string, right: string): boolean {
  if (left === '' || right === '') return false;
  if (left === right) return true;
  return left.length >= 3 && right.length >= 3 && (left.includes(right) || right.includes(left));
}
