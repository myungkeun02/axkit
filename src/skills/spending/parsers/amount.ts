export interface AmountMatch {
  amount: number;
  currency: string;
  index: number;
  length: number;
}

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

interface AmountPattern {
  currency: string;
  pattern: RegExp;
}

/** Each pattern captures the numeric text in one of its groups; the first defined group is the value. */
const PATTERNS: readonly AmountPattern[] = [
  {
    currency: 'KRW',
    pattern: new RegExp(String.raw`(?:₩|KRW)\s*(${NUMBER})|(${NUMBER})\s*원`, 'gi'),
  },
  {
    currency: 'USD',
    pattern: new RegExp(
      String.raw`(?:US\$|USD)\s*(${NUMBER})|(${NUMBER})\s*USD\b|\$\s*(${NUMBER})`,
      'gi',
    ),
  },
  {
    currency: 'EUR',
    pattern: new RegExp(String.raw`(?:€|EUR)\s*(${NUMBER})|(${NUMBER})\s*EUR\b`, 'gi'),
  },
  {
    currency: 'JPY',
    pattern: new RegExp(String.raw`(?:¥|JPY)\s*(${NUMBER})|(${NUMBER})\s*(?:JPY|円)`, 'gi'),
  },
  {
    currency: 'GBP',
    pattern: new RegExp(String.raw`(?:£|GBP)\s*(${NUMBER})|(${NUMBER})\s*GBP\b`, 'gi'),
  },
];

function firstGroup(match: RegExpMatchArray): string | undefined {
  for (let index = 1; index < match.length; index += 1) {
    const value = match[index];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Every money amount in the text, in the order it appears. Currency symbols, prefixes and suffixes all work. */
export function findAmounts(text: string): AmountMatch[] {
  const found: AmountMatch[] = [];
  for (const { currency, pattern } of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = firstGroup(match);
      if (raw === undefined) continue;
      const amount = Number(raw.replaceAll(',', ''));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      found.push({ amount, currency, index: match.index ?? 0, length: match[0].length });
    }
  }
  return found.sort((left, right) => left.index - right.index);
}
