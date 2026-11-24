import { normalizeText } from '../../core/time/evidence.js';

/** Trailing particles the owner adds to names and nouns in a sentence. Longest first. */
const TOKEN_SUFFIXES = [
  '이랑',
  '하고',
  '한테',
  '에게',
  '에서',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '에',
  '의',
  '도',
  '랑',
  '와',
  '과',
  '님',
];

const ORDERED_SUFFIXES = [...TOKEN_SUFFIXES].sort((a, b) => b.length - a.length);

/** One-character particles only come off words that stay at least two characters: "지은" is a name. */
function stripParticle(token: string): string {
  let current = token;
  for (;;) {
    const suffix = ORDERED_SUFFIXES.find((candidate) => {
      const rest = current.length - candidate.length;
      return rest >= (candidate.length >= 2 ? 1 : 2) && current.endsWith(candidate);
    });
    if (suffix === undefined) return current;
    current = current.slice(0, -suffix.length);
  }
}

/** Normalized words with Korean particles stripped from token ends, for overlap ranking. */
export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .map(stripParticle)
    .filter((token) => token.length > 0);
}

export function tokenSet(text: string): ReadonlySet<string> {
  return new Set(tokenize(text));
}
